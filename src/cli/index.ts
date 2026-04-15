#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../config/loader.js';
import { Database } from '../positions/db.js';
import { getConnection, getKitRpc } from '../utils/rpc.js';
import { runScan } from '../scanner/index.js';
import { scoreAll } from '../scoring/engine.js';
import { buildExecutionPlan } from '../executor/index.js';
import { PositionStateMachine, validateNewPosition } from '../positions/statemachine.js';
import { computeCashFlowPnl, computeMtmPnl } from '../positions/pnl.js';
import { TelegramReporter } from '../reporter/telegram.js';
import { runBacktest, printBacktestSummary } from '../backtest/runner.js';
import { logger } from '../utils/logger.js';
import { RAGStore } from '../rag/store.js';
import { createEmbeddingModel } from '../embeddings/factory.js';
import { getDecisionSource, logPositionDecisionEpisode } from '../rag/decision-logger.js';
import { gradeDecision, generateLesson } from '../rag/grader.js';
import { trackPositionOutcome } from '../rag/outcome-tracker.js';
import { buildCooldownUntil, shouldStartPoolCooldown } from '../portfolio/cooldown.js';
import { extractBaseMintFromRawData } from '../portfolio/token-memory.js';
import type { DecisionEpisode } from '../rag/decision-types.js';
import { buildExecutionOpportunity } from '../positions/dlmm-sync.js';

const program = new Command();
program.name('yield-agent').description('Solana DeFi yield optimization agent').version('0.1.0');

// ---------------------------------------------------------------------------
// Shared initialization
// ---------------------------------------------------------------------------

function init() {
  const config = loadConfig();
  const db = new Database(config.databaseUrl);
  const connection = getConnection(config);
  const kitRpc = getKitRpc(config);
  return { config, db, connection, kitRpc };
}

// ---------------------------------------------------------------------------
// scan — run full scanner and print top opportunities
// ---------------------------------------------------------------------------

program
  .command('scan')
  .description('Run scanner now (ignores cron). Print top 10 scored opportunities.')
  .action(async () => {
    const { config, db, connection, kitRpc } = init();
    try {
      const opps = await runScan(config, connection, kitRpc);
      const scored = scoreAll(opps, config);

      // Persist to opportunities table
      for (const opp of scored) {
        await db.insertOpportunity({
          protocol: opp.protocol,
          pool_id: opp.poolId,
          pool_name: opp.poolName,
          apy_defillama: opp.apyDefillama,
          apy_protocol: opp.apyProtocol,
          apy_used: opp.apyUsed,
          data_uncertain: opp.dataUncertain ? 1 : 0,
          tvl_usd: opp.tvlUsd,
          score: opp.score,
          raw_data: null,
        });
      }

      console.log(`\nTop ${Math.min(10, scored.length)} Opportunities:\n`);
      console.log(
        'Protocol'.padEnd(18) +
          'Pool'.padEnd(30) +
          'APY'.padEnd(8) +
          'Score'.padEnd(8) +
          'Rec'.padEnd(10) +
          'Uncertain'
      );
      console.log('─'.repeat(82));

      for (const opp of scored.slice(0, 10)) {
        console.log(
          opp.protocol.padEnd(18) +
            opp.poolName.slice(0, 29).padEnd(30) +
            `${opp.apyUsed.toFixed(2)}%`.padEnd(8) +
            opp.score.toFixed(1).padEnd(8) +
            opp.recommendation.padEnd(10) +
            (opp.dataUncertain ? '⚠️' : '✅')
        );
      }
      console.log(`\nTotal: ${scored.length} opportunities found and stored.`);
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// suggest — show SUGGEST-tier opportunities not yet in positions
// ---------------------------------------------------------------------------

program
  .command('suggest')
  .description('Show all SUGGEST-tier opportunities not yet opened as positions.')
  .action(async () => {
    const { config, db, connection, kitRpc } = init();
    try {
      const opps = await runScan(config, connection, kitRpc);
      const scored = scoreAll(opps, config);
      const suggestions = scored.filter((s) => s.recommendation === 'SUGGEST');

      console.log(`\nSUGGEST-tier opportunities (${suggestions.length}):\n`);
      for (const opp of suggestions) {
        console.log(
          `${opp.poolName} | APY: ${opp.apyUsed.toFixed(2)}% | Score: ${opp.score.toFixed(1)} | TVL: $${(opp.tvlUsd / 1e6).toFixed(1)}M${opp.dataUncertain ? ' ⚠️' : ''}`
        );
        console.log(`  Pool ID: ${opp.poolId}`);
      }
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// open — create a PENDING_OPEN position for an opportunity
// ---------------------------------------------------------------------------

program
  .command('open')
  .description('Create a PENDING_OPEN position for a given opportunity ID.')
  .requiredOption('--opportunity <id>', 'Opportunity pool ID from scan output')
  .requiredOption('--size <usd>', 'Position size in USD')
  .option('--book <book>', 'Portfolio book (core|scout)', 'core')
  .action(async (opts: { opportunity: string; size: string; book: string }) => {
    const { config, db } = init();
    try {
      const sizeUsd = parseFloat(opts.size);
      if (isNaN(sizeUsd)) {
        console.error('Invalid size value');
        process.exit(1);
      }

      if (opts.book !== 'core' && opts.book !== 'scout') {
        console.error('Invalid book value. Use core or scout.');
        process.exit(1);
      }

      // Find the opportunity in the latest scan results
      const latestOpps = await db.getLatestOpportunities(100);
      const opp = latestOpps.find((o) => o.pool_id === opts.opportunity || o.id === opts.opportunity);

      if (!opp) {
        console.error(`Opportunity not found: ${opts.opportunity}`);
        console.error('Run `npm run cli -- scan` first to populate opportunities.');
        process.exit(1);
      }

      const guard = await validateNewPosition(sizeUsd, config, db, opp.protocol, opp.pool_name, opp.pool_id, extractBaseMintFromRawData(opp.raw_data));
      if (!guard.success) {
        console.error(`Cannot open position: ${guard.error}`);
        process.exit(1);
      }

      const position = await db.insertPosition({
        opportunity_id: opp.id,
        protocol: opp.protocol,
        pool_id: opp.pool_id,
        pool_name: opp.pool_name,
        state: 'PENDING_OPEN',
        book: opts.book,
        base_mint: extractBaseMintFromRawData(opp.raw_data),
        size_usd: sizeUsd,
        entry_apy: opp.apy_used,
        entry_price_sol: null,
        opened_at: null,
        closed_at: null,
        close_reason: null,
        notes: null,
      });

      await logPositionDecisionEpisode({
        db,
        position,
        action: 'open',
        signalTypes: ['CLI_OPEN'],
        reasoning: `Opened ${opp.protocol}/${opp.pool_name} from the CLI [${opts.book}].`,
        marketRegime: null,
        solPriceUsd: null,
        source: getDecisionSource(config.paperTrading),
      });

      console.log(`\nPosition created:`);
      console.log(`  ID:       ${position.id}`);
      console.log(`  Pool:     ${position.pool_name}`);
      console.log(`  Protocol: ${position.protocol}`);
      console.log(`  Book:     ${position.book ?? '-'}`);
      console.log(`  Size:     $${sizeUsd}`);
      console.log(`  APY:      ${position.entry_apy.toFixed(2)}%`);
      console.log(`  State:    ${position.state}`);
      console.log(`\nNext: run 'execute' to build the transaction:`);
      console.log(`  npm run cli -- execute --position=${position.id}`);
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// execute — build + simulate tx for a PENDING_OPEN or PENDING_CLOSE position
// ---------------------------------------------------------------------------

program
  .command('execute')
  .description('Build and simulate the transaction for a PENDING_OPEN or PENDING_CLOSE position.')
  .requiredOption('--position <id>', 'Position ID')
  .action(async (opts: { position: string }) => {
    const { config, db, connection, kitRpc } = init();
    try {
      const position = await db.getPosition(opts.position);
      if (!position) {
        console.error(`Position not found: ${opts.position}`);
        process.exit(1);
      }

      if (position.state !== 'PENDING_OPEN' && position.state !== 'PENDING_CLOSE') {
        console.error(`Position state is ${position.state}. Only PENDING_OPEN or PENDING_CLOSE can be executed.`);
        process.exit(1);
      }

      const action = position.state === 'PENDING_OPEN' ? 'open' : 'close';

      // Re-scan to get a scored opportunity for this position
      const opps = await runScan(config, connection, kitRpc);
      const scored = scoreAll(opps, config);
      const scoredOpp = scored.find((o) => o.poolId === position.pool_id);
      const storedOpportunity = await db.getOpportunity(position.opportunity_id);
      const executionOpportunity = scoredOpp ?? buildExecutionOpportunity(position, storedOpportunity);

      await buildExecutionPlan(executionOpportunity, position.id, action, connection, config, db);
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// confirm — mark position as executed after human signs
// ---------------------------------------------------------------------------

program
  .command('confirm')
  .description('Confirm a position was manually executed on-chain.')
  .requiredOption('--position <id>', 'Position ID')
  .requiredOption('--signature <sig>', 'Transaction signature from wallet')
  .action(async (opts: { position: string; signature: string }) => {
    const { config, db } = init();
    try {
      const position = await db.getPosition(opts.position);
      if (!position) {
        console.error(`Position not found: ${opts.position}`);
        process.exit(1);
      }

      const sm = new PositionStateMachine(db, config);
      let targetState: 'ACTIVE' | 'CLOSED';

      if (position.state === 'PENDING_OPEN') {
        targetState = 'ACTIVE';
      } else if (position.state === 'PENDING_CLOSE') {
        targetState = 'CLOSED';
      } else {
        console.error(`Position is in state ${position.state} — nothing to confirm.`);
        process.exit(1);
      }

      const result = await sm.transition(opts.position, targetState, { txSignature: opts.signature });

      if (!result.success) {
        console.error(`Transition failed: ${result.error}`);
        process.exit(1);
      }

      // Mark the latest execution log as executed
      const logs = await db.getExecutionLogsByPosition(opts.position);
      const latestUnexecuted = logs.find((l) => l.executed === 0);
      if (latestUnexecuted) {
        await db.markExecutionLogExecuted(latestUnexecuted.id, opts.signature);
      }

      if (targetState === 'CLOSED') {
        const closedPosition = await db.getPosition(opts.position);
        if (closedPosition) {
          const closeReason = closedPosition.close_reason ?? 'manual';

          if (shouldStartPoolCooldown(closeReason)) {
            await db.upsertPoolCooldown({
              pool_id: closedPosition.pool_id,
              reason: closeReason,
              cooldown_until: buildCooldownUntil(
                new Date().toISOString(),
                config.allocator.cooldown_hours_after_bad_exit,
              ),
              source_position_id: closedPosition.id,
            });
          }

          const embeddingModel = createEmbeddingModel(config);
          const ragStore = new RAGStore(config, embeddingModel);
          await ragStore.init();
          await trackPositionOutcome(db, ragStore, closedPosition, closeReason, null, null);
        }
      }

      console.log(`\nPosition ${opts.position} confirmed.`);
      console.log(`  New state:   ${result.newState}`);
      console.log(`  Tx signature: ${opts.signature}`);
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// close — transition ACTIVE position to PENDING_CLOSE
// ---------------------------------------------------------------------------

program
  .command('close')
  .description('Transition an ACTIVE position to PENDING_CLOSE.')
  .requiredOption('--position <id>', 'Position ID')
  .option('--reason <reason>', 'Close reason (manual|rebalance|circuit_breaker|apy_drop)', 'manual')
  .action(async (opts: { position: string; reason: string }) => {
    const { config, db } = init();
    try {
      const sm = new PositionStateMachine(db, config);
      const validReasons = ['manual', 'rebalance', 'circuit_breaker', 'apy_drop'] as const;
      const reason = validReasons.includes(opts.reason as typeof validReasons[number])
        ? (opts.reason as typeof validReasons[number])
        : 'manual';

      const result = await sm.transition(opts.position, 'PENDING_CLOSE', { closeReason: reason });

      if (!result.success) {
        console.error(`Failed to close position: ${result.error}`);
        process.exit(1);
      }

      const pendingClosePosition = await db.getPosition(opts.position);
      if (pendingClosePosition) {
        await logPositionDecisionEpisode({
          db,
          position: pendingClosePosition,
          action: 'close',
          signalTypes: ['CLI_CLOSE'],
          reasoning: `Closed ${pendingClosePosition.protocol}/${pendingClosePosition.pool_name} from the CLI (${reason}).`,
          marketRegime: null,
          solPriceUsd: null,
          source: getDecisionSource(config.paperTrading),
        });
      }

      console.log(`Position ${opts.position} moved to PENDING_CLOSE (reason: ${reason}).`);
      console.log(`Next: run 'execute' to build the close transaction:`);
      console.log(`  npm run cli -- execute --position=${opts.position}`);
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// positions — list all positions with current state and PnL
// ---------------------------------------------------------------------------

program
  .command('positions')
  .description('List all positions with current state and PnL snapshot.')
  .action(async () => {
    const { db } = init();
    try {
      const positions = await db.getAllPositions();

      if (positions.length === 0) {
        console.log('No positions found.');
        return;
      }

      console.log(
        '\nID'.padEnd(38) +
          'Book'.padEnd(12) +
          'Protocol'.padEnd(18) +
          'Pool'.padEnd(25) +
          'State'.padEnd(20) +
          'Size'.padEnd(10) +
          'APY'.padEnd(8) +
          'Est. PnL'
      );
      console.log('─'.repeat(130));

      for (const pos of positions) {
        const cf = computeCashFlowPnl(pos);
        console.log(
          pos.id.padEnd(38) +
            (pos.book ?? '-').padEnd(12) +
            pos.protocol.padEnd(18) +
            pos.pool_name.slice(0, 24).padEnd(25) +
            pos.state.padEnd(20) +
            `$${pos.size_usd.toFixed(0)}`.padEnd(10) +
            `${pos.entry_apy.toFixed(1)}%`.padEnd(8) +
            `$${cf.cashFlowPnlUsd.toFixed(4)}`
        );
      }
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// report — generate and optionally send Telegram daily report
// ---------------------------------------------------------------------------

program
  .command('report')
  .description('Generate and print (or send) the Telegram daily report.')
  .action(async () => {
    const { config, db, connection, kitRpc } = init();
    try {
      const opps = await runScan(config, connection, kitRpc);
      const scored = scoreAll(opps, config);
      const activePositions = await db.getPositionsByState('ACTIVE');
      const pendingRebalance = await db.getPositionsByState('PENDING_REBALANCE');

      const cfPnls = activePositions.map((p) => computeCashFlowPnl(p));
      const mtmPnls = activePositions.map((p) => computeMtmPnl(p));
      const deployedCapital = activePositions.reduce((s, p) => s + p.size_usd, 0);

      const reporter = new TelegramReporter(config);
      await reporter.sendDailyReport({
        openPositions: activePositions,
        cashFlowPnls: cfPnls,
        mtmPnls: mtmPnls,
        suggestions: scored,
        uncertainOpportunities: scored.filter((s) => s.dataUncertain),
        pendingRebalance,
        circuitBreakerActive: false, // Phase 1: manual check only
        deployedCapitalUsd: deployedCapital,
        walletBalanceUsd: deployedCapital, // Phase 1: no live balance fetch
        bookSummaries: ['core', 'scout', 'unassigned'].map((book) => {
          const positions = activePositions.filter((position) => (position.book ?? 'unassigned') === book);
          const positionIds = new Set(positions.map((position) => position.id));
          return {
            book: book as 'core' | 'scout' | 'unassigned',
            openPositions: positions.length,
            deployedUsd: positions.reduce((sum, position) => sum + position.size_usd, 0),
            cashFlowPnlUsd: cfPnls.filter((pnl) => positionIds.has(pnl.positionId)).reduce((sum, pnl) => sum + pnl.cashFlowPnlUsd, 0),
            mtmPnlUsd: mtmPnls.filter((pnl) => positionIds.has(pnl.positionId)).reduce((sum, pnl) => sum + pnl.mtmPnlUsd, 0),
          };
        }),
      });
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// backtest — run historical simulation
// ---------------------------------------------------------------------------

program
  .command('backtest')
  .description('Run backtest mode against DefiLlama historical data.')
  .option('--days <n>', 'Number of days to simulate', '30')
  .action(async (opts: { days: string }) => {
    const { config, db } = init();
    try {
      const days = parseInt(opts.days, 10);
      if (isNaN(days) || days < 1) {
        console.error('Invalid --days value');
        process.exit(1);
      }

      const summary = await runBacktest(config, days);
      printBacktestSummary(summary);
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// seed-episodes — run simulation and ingest synthetic episodes
// ---------------------------------------------------------------------------

program
  .command('seed-episodes')
  .description('Run backtest mode and ingest the simulated outcomes as synthetic learning episodes.')
  .option('--days <n>', 'Number of days to simulate', '30')
  .action(async (opts: { days: string }) => {
    const { config, db } = init();
    try {
      const days = parseInt(opts.days, 10);
      const summary = await runBacktest(config, days);
      
      const embeddingModel = createEmbeddingModel(config);
      const ragStore = new RAGStore(config, embeddingModel);
      await ragStore.init();
      
      let seeded = 0;
      for (const pos of summary.positions) {
        // Construct synthetic episode
        const episode: DecisionEpisode = {
          episodeId: '', // placeholder, DB generates it
          decisionAt: pos.entryDate,
          signalTypes: ['BACKTEST_SIGNAL'],
          marketRegime: null,
          solPriceUsd: null,
          portfolioSizeUsd: 1000,
          activePositionCount: 0,
          action: 'open',
          reasoning: 'Synthetic execution from backtest runner',
          targetPoolId: pos.poolId,
          targetProtocol: 'kamino', // approximation for mock,
          targetPoolName: pos.poolName,
          positionSizeUsd: 100,
          positionId: null,
          outcome: {
            resolvedAt: pos.exitDate,
            netPnlUsd: pos.netPnlUsd,
            realizedApyPct: pos.twAvgApy,
            daysHeld: pos.daysHeld,
            exitReason: 'backtest_simulation_end',
            exitMarketRegime: null,
            exitSolPriceUsd: null
          },
          grade: null,
          lessonLearned: null,
          source: 'backtest'
        };
        
        episode.grade = gradeDecision(episode);
        episode.lessonLearned = generateLesson(episode);
        
        const row = await db.insertDecisionEpisode({
          decision_at: episode.decisionAt,
          action: episode.action,
          signal_types: episode.signalTypes.join(','),
          market_regime: episode.marketRegime,
          sol_price_usd: episode.solPriceUsd,
          portfolio_size_usd: episode.portfolioSizeUsd,
          active_position_count: episode.activePositionCount,
          target_pool_id: episode.targetPoolId,
          target_protocol: episode.targetProtocol,
          target_pool_name: episode.targetPoolName,
          position_size_usd: episode.positionSizeUsd,
          position_id: episode.positionId,
          book: null,
          reasoning: episode.reasoning,
          source: episode.source,
          outcome_resolved_at: episode.outcome!.resolvedAt,
          outcome_net_pnl_usd: episode.outcome!.netPnlUsd,
          outcome_realized_apy_pct: episode.outcome!.realizedApyPct,
          outcome_days_held: episode.outcome!.daysHeld,
          outcome_exit_reason: episode.outcome!.exitReason,
          outcome_exit_regime: episode.outcome!.exitMarketRegime,
          outcome_exit_sol_price: episode.outcome!.exitSolPriceUsd,
          grade: episode.grade,
          lesson_learned: episode.lessonLearned,
        });

        if (episode.lessonLearned) {
          await ragStore.upsert([
            {
              id: `lesson:syn-${row.id}`,
              text: episode.lessonLearned,
              metadata: {
                type: 'lesson_learned',
                grade: episode.grade,
                action: episode.action,
                protocol: episode.targetProtocol ?? '',
                pnl_usd: episode.outcome!.netPnlUsd,
                days_held: episode.outcome!.daysHeld,
                source: episode.source,
                date: episode.outcome!.resolvedAt.slice(0, 10),
              },
            },
          ]);
          seeded++;
        }
      }
      
      console.log(`\nSuccessfully seeded ${seeded} synthetic learning episodes from ${summary.tradesOpened} simulated trades.\n`);
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// lessons — view accumulated agent experience
// ---------------------------------------------------------------------------

program
  .command('lessons')
  .description('Print recent lessons learned by the agent.')
  .option('--limit <n>', 'Number of lessons to show', '10')
  .action(async (opts: { limit: string }) => {
    const { db } = init();
    try {
      const stats = await db.getEpisodeStats();
      console.log(`\nAgent Experience Overivew`);
      console.log(`Total episodes: ${stats.total}`);
      console.log(`Graded: ${stats.graded}`);
      console.log(`Wins: ${(stats.byGrade['EXCELLENT'] ?? 0) + (stats.byGrade['GOOD'] ?? 0)} | Neutral: ${stats.byGrade['NEUTRAL'] ?? 0} | Losses: ${(stats.byGrade['BAD'] ?? 0) + (stats.byGrade['TERRIBLE'] ?? 0)}`);
      
      const lessons = await db.getRecentLessons(parseInt(opts.limit, 10));
      if (lessons.length === 0) {
        console.log('\nNo lessons accumulated yet.');
      } else {
        console.log('\nMost Recent Lessons:');
        for (const l of lessons) {
          const age = Math.round((Date.now() - new Date(l.decision_at).getTime()) / (1000 * 60 * 60 * 24));
          console.log(`\n[${age} days ago] Grade: ${l.grade}`);
          console.log(`> ${l.lesson_learned}`);
        }
      }
      console.log('');
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error({ err }, 'CLI error');
  process.exit(1);
});
