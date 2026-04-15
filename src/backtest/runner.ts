import { fetchDefiLlamaPools, fetchPoolHistory, type DefiLlamaChartPoint } from '../scanner/defillama.js';
import { scoreAll, type RawOpportunity, type ScoredOpportunity } from '../scoring/engine.js';
import type { AgentConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { computeStandardIL } from '../positions/il-calculator.js';

const GAS_COST_USD = 0.001;

export interface BacktestPositionResult {
  poolId: string;
  poolName: string;
  entryDate: string;
  exitDate: string;
  entryApy: number;
  exitApy: number;
  twAvgApy: number;
  daysHeld: number;
  cashFlowPnlUsd: number;
  ilUsd: number;
  netPnlUsd: number;
  annualizedReturnPct: number;
  isLp: boolean;
  win: boolean;
}

export interface CapitalUtilizationPoint {
  date: string;
  pct: number;
}

export interface BacktestSummary {
  days: number;
  poolsScanned: number;
  tradesOpened: number;
  tradesClosed: number;
  totalCashFlowPnlUsd: number;
  totalIlUsd: number;
  netPnlUsd: number;
  blendedApyPct: number;
  annualizedReturnPct: number;
  capitalUtilizationPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  winRate: number;
  avgDaysPerPosition: number;
  capitalUtilizationTimeSeries: CapitalUtilizationPoint[];
  positions: BacktestPositionResult[];
  disclaimer: string;
}

const DISCLAIMER =
  '⚠ Backtest models APY decay and basic IL for LP positions. ' +
  'Does not model slippage, liquidity constraints, or MEV. ' +
  'Results are directional only — not a forecast of live PnL.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDateIndex(
  points: DefiLlamaChartPoint[]
): Map<string, DefiLlamaChartPoint> {
  const byDate = new Map<string, DefiLlamaChartPoint>();
  for (const p of points) {
    const dateKey = p.timestamp.slice(0, 10);
    byDate.set(dateKey, p);
  }
  return byDate;
}

function getDateRange(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function computeTwAvgApy(
  byDate: Map<string, DefiLlamaChartPoint>,
  entryIdx: number,
  exitIdx: number,
  dateRange: string[]
): number {
  let weightedSum = 0;
  let totalDays = 0;

  for (let i = entryIdx; i < exitIdx; i++) {
    const date = dateRange[i];
    if (!date) continue;
    const point = byDate.get(date);
    if (!point) continue;

    const nextDate = dateRange[i + 1];
    const nextPoint = nextDate ? byDate.get(nextDate) : point;
    const daysInPeriod = nextPoint
      ? 1
      : 1;
    weightedSum += point.apy * daysInPeriod;
    totalDays += daysInPeriod;
  }

  return totalDays > 0 ? weightedSum / totalDays : 0;
}

function computeSharpeRatio(returns: number[]): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  const annualizedMean = mean * 365;
  const annualizedStdDev = stdDev * Math.sqrt(365);

  return annualizedStdDev > 0 ? annualizedMean / annualizedStdDev : 0;
}

function computeMaxDrawdown(cumulativeReturns: number[]): number {
  let peak = cumulativeReturns[0] ?? 0;
  let maxDrawdown = 0;

  for (const ret of cumulativeReturns) {
    if (ret > peak) peak = ret;
    const drawdown = ((peak - ret) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return maxDrawdown;
}

const LP_PROTOCOLS = new Set(['meteora_dlmm', 'kamino_vaults']);

export async function runBacktest(
  config: AgentConfig,
  days = 30
): Promise<BacktestSummary> {
  logger.info({ days }, 'Starting backtest');

  const llamaPools = await fetchDefiLlamaPools(config.defillamaBaseUrl);

  const candidatePools = [...llamaPools.values()].filter(
    (p) =>
      (p.apy ?? 0) >= config.scoring.min_apy_pct &&
      p.tvlUsd >= config.scoring.min_tvl_usd
  );
  const poolIds = candidatePools.map((p) => p.pool);

  logger.info(
    { total: llamaPools.size, candidates: poolIds.length },
    'Fetching historical data for qualifying pools only'
  );

  const historicalData = new Map<string, Map<string, DefiLlamaChartPoint>>();
  let fetched = 0;
  for (const poolId of poolIds) {
    await sleep(200);
    const history = await fetchPoolHistory(poolId, config.defillamaBaseUrl);
    if (history.length > 0) {
      historicalData.set(poolId, buildDateIndex(history));
      fetched++;
    }
    if (fetched % 10 === 0 && fetched > 0) {
      logger.info({ fetched, total: poolIds.length }, 'Fetching historical data...');
    }
  }

  logger.info({ fetched }, 'Historical data fetched');

  const dateRange = getDateRange(days);
  const positions: BacktestPositionResult[] = [];
  let totalPnl = 0;
  let totalIl = 0;
  const POSITION_SIZE_USD = Math.min(config.position.max_position_usd, 100);

  const capitalUtilizationTimeSeries: CapitalUtilizationPoint[] = [];
  let deployedCapital = 0;
  const maxCapital = POSITION_SIZE_USD * config.position.max_open_positions;

  for (let dayIdx = 0; dayIdx < dateRange.length; dayIdx++) {
    const date = dateRange[dayIdx];
    if (!date) continue;

    const dayOpps: RawOpportunity[] = [];
    for (const [poolId, byDate] of historicalData) {
      const point = byDate.get(date);
      if (!point) continue;

      const llamaPool = llamaPools.get(poolId);
      if (!llamaPool) continue;

      const protocol = mapProjectToProtocol(llamaPool.project);
      if (!protocol) continue;

      dayOpps.push({
        poolId,
        protocol,
        poolName: `${llamaPool.symbol} (backtest)`,
        apyDefillama: point.apy,
        apyProtocol: null,
        apyUsed: point.apy,
        tvlUsd: point.tvlUsd,
        dataUncertain: true,
      });
    }

    const scored: ScoredOpportunity[] = scoreAll(dayOpps, config, 'LOW_VOL_RANGE');
    const topSuggest = scored.filter((s) => s.recommendation === 'SUGGEST')[0];

    if (topSuggest && dayIdx < dateRange.length - 1) {
      const entryApy = topSuggest.apyUsed;
      const isLp = LP_PROTOCOLS.has(topSuggest.protocol);
      let exitDayIdx = dateRange.length - 1;
      let exitApy = entryApy;

      for (let j = dayIdx + 1; j < dateRange.length; j++) {
        const futureDate = dateRange[j];
        if (!futureDate) continue;
        const futurePoint = historicalData.get(topSuggest.poolId)?.get(futureDate);
        if (!futurePoint) continue;

        const dropPct = ((entryApy - futurePoint.apy) / entryApy) * 100;
        if (dropPct > config.rebalance.apy_drop_trigger_pct) {
          exitDayIdx = j;
          exitApy = futurePoint.apy;
          break;
        }
      }

      const exitDate = dateRange[exitDayIdx] ?? date;
      const daysHeld = exitDayIdx - dayIdx;

      if (daysHeld > 0) {
        const byDate = historicalData.get(topSuggest.poolId);
        const twAvgApy = byDate
          ? computeTwAvgApy(byDate, dayIdx, exitDayIdx, dateRange)
          : entryApy;

        const yieldEarned = POSITION_SIZE_USD * (twAvgApy / 100) * (daysHeld / 365);
        const gasCost = GAS_COST_USD * 2;

        let ilUsd = 0;
        if (isLp) {
          const entryDate = dateRange[dayIdx];
          const exitDateStr = exitDate;
          const entryPoint = entryDate ? byDate?.get(entryDate) : undefined;
          const exitPoint = exitDateStr ? byDate?.get(exitDateStr) : undefined;

          if (entryPoint && exitPoint && entryPoint.tvlUsd && exitPoint.tvlUsd) {
            const priceRatio = exitPoint.tvlUsd / entryPoint.tvlUsd;
            const ilPct = computeStandardIL(1, priceRatio);
            ilUsd = Math.abs(POSITION_SIZE_USD * ilPct);
          }
        }

        const cashFlowPnl = yieldEarned - gasCost;
        const netPnl = cashFlowPnl - ilUsd;
        const annualizedReturn = (netPnl / POSITION_SIZE_USD / (daysHeld / 365)) * 100;

        positions.push({
          poolId: topSuggest.poolId,
          poolName: topSuggest.poolName,
          entryDate: date,
          exitDate,
          entryApy,
          exitApy,
          twAvgApy,
          daysHeld,
          cashFlowPnlUsd: cashFlowPnl,
          ilUsd,
          netPnlUsd: netPnl,
          annualizedReturnPct: annualizedReturn,
          isLp,
          win: netPnl > 0,
        });

        totalPnl += netPnl;
        totalIl += ilUsd;
        dayIdx = exitDayIdx;
      }
    }

    deployedCapital = positions.reduce((sum, p) => {
      const posExitDate = dateRange.indexOf(p.exitDate);
      const posEntryDate = dateRange.indexOf(p.entryDate);
      if (dayIdx >= posEntryDate && dayIdx <= posExitDate) {
        return sum + POSITION_SIZE_USD;
      }
      return sum;
    }, 0);

    capitalUtilizationTimeSeries.push({
      date,
      pct: maxCapital > 0 ? (deployedCapital / maxCapital) * 100 : 0,
    });
  }

  const blendedApy =
    positions.length > 0
      ? positions.reduce((s, p) => s + p.twAvgApy, 0) / positions.length
      : 0;

  const totalDaysDeployed = positions.reduce((s, p) => s + p.daysHeld, 0);
  const annualizedReturn = totalDaysDeployed > 0
    ? (totalPnl / POSITION_SIZE_USD / (totalDaysDeployed / 365)) * 100
    : 0;

  const capitalUtilization = positions.length > 0
    ? (totalDaysDeployed / days) * 100
    : 0;

  const winRate = positions.length > 0
    ? (positions.filter((p) => p.win).length / positions.length) * 100
    : 0;

  const avgDaysPerPosition = positions.length > 0
    ? totalDaysDeployed / positions.length
    : 0;

  const dailyReturns = positions.map((p) => p.annualizedReturnPct / 365);
  const sharpeRatio = computeSharpeRatio(dailyReturns);

  const cumulativeReturns = [0];
  for (const p of positions) {
    cumulativeReturns.push(cumulativeReturns[cumulativeReturns.length - 1]! + p.netPnlUsd);
  }
  const maxDrawdownPct = computeMaxDrawdown(cumulativeReturns);

  logger.info({ positions: positions.length, totalPnl }, 'Backtest complete');

  return {
    days,
    poolsScanned: historicalData.size,
    tradesOpened: positions.length,
    tradesClosed: positions.length,
    totalCashFlowPnlUsd: totalPnl + totalIl,
    totalIlUsd: totalIl,
    netPnlUsd: totalPnl,
    blendedApyPct: blendedApy,
    annualizedReturnPct: annualizedReturn,
    capitalUtilizationPct: capitalUtilization,
    sharpeRatio,
    maxDrawdownPct,
    winRate,
    avgDaysPerPosition,
    capitalUtilizationTimeSeries,
    positions,
    disclaimer: DISCLAIMER,
  };
}

function mapProjectToProtocol(project: string): RawOpportunity['protocol'] | null {
  const map: Record<string, RawOpportunity['protocol']> = {
    'kamino-lend': 'kamino_lending',
    'kamino-liquidity': 'kamino_vaults',
    'marginfi-lst': 'marginfi',
    'jito-liquid-staking': 'jito',
  };
  return map[project] ?? null;
}

export function printBacktestSummary(summary: BacktestSummary): void {
  console.log('\n' + '═'.repeat(60));
  console.log('BACKTEST RESULTS');
  console.log('═'.repeat(60));
  console.log(`Period:              ${summary.days} days`);
  console.log(`Pools scanned:       ${summary.poolsScanned}`);
  console.log(`Trades opened:       ${summary.tradesOpened}`);
  console.log(`Trades closed:       ${summary.tradesClosed}`);
  console.log(`Total PnL (gross):  $${summary.totalCashFlowPnlUsd.toFixed(4)}`);
  console.log(`IL loss:             $${summary.totalIlUsd.toFixed(4)}`);
  console.log(`Net PnL:            $${summary.netPnlUsd.toFixed(4)}`);
  console.log(`Blended TW APY:     ${summary.blendedApyPct.toFixed(2)}%`);
  console.log(`Annualized return:   ${summary.annualizedReturnPct.toFixed(2)}%`);
  console.log(`Sharpe ratio:       ${summary.sharpeRatio.toFixed(2)}`);
  console.log(`Max drawdown:       ${summary.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Win rate:           ${summary.winRate.toFixed(1)}%`);
  console.log(`Avg days/position:  ${summary.avgDaysPerPosition.toFixed(1)}`);
  console.log(`Capital util:       ${summary.capitalUtilizationPct.toFixed(1)}%`);

  if (summary.positions.length > 0) {
    console.log('\nPosition breakdown:');
    console.log(
      'Entry'.padEnd(10) +
        'Exit'.padEnd(10) +
        'Pool'.padEnd(22) +
        'TW APY'.padEnd(8) +
        'Days'.padEnd(5) +
        'Net PnL'
    );
    console.log('─'.repeat(80));
    for (const pos of summary.positions) {
      console.log(
        pos.entryDate.slice(5).padEnd(10) +
          pos.exitDate.slice(5).padEnd(10) +
          pos.poolName.slice(0, 21).padEnd(22) +
          `${pos.twAvgApy.toFixed(1)}%`.padEnd(8) +
          String(pos.daysHeld).padEnd(5) +
          `$${pos.netPnlUsd.toFixed(4)}`
      );
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(summary.disclaimer);
  console.log('─'.repeat(60) + '\n');
}
