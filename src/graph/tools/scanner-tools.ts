import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import type { AgentConfig } from '../../config/loader.js';
import type { Database } from '../../positions/db.js';
import { runScan } from '../../scanner/index.js';
import { scoreAll } from '../../scoring/engine.js';
import { fetchPoolHistory } from '../../scanner/defillama.js';

type KitRpc = ReturnType<typeof createSolanaRpc>;

// Cast helper — zod 3.25 + exactOptionalPropertyTypes causes false type error
// with @langchain/core tool() overloads. Runtime is correct.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = <T extends z.ZodRawShape>(s: z.ZodObject<T>): any => s;

export function createScannerTools(
  config: AgentConfig,
  db: Database,
  connection: Connection,
  kitRpc: KitRpc
) {
  const scanMarkets = tool(
    async () => {
      const raw = await runScan(config, connection, kitRpc);
      const scored = scoreAll(raw, config);
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
          raw_data: opp.raw_data ?? null,
        });
      }
      return JSON.stringify({
        total: scored.length,
        suggest: scored.filter((o) => o.recommendation === 'SUGGEST').length,
        watch: scored.filter((o) => o.recommendation === 'WATCH').length,
        opportunities: scored.map((o) => ({
          poolId: o.poolId,
          protocol: o.protocol,
          poolName: o.poolName,
          apyPct: o.apyUsed,
          tvlUsd: o.tvlUsd,
          score: o.score,
          recommendation: o.recommendation,
          dataUncertain: o.dataUncertain,
        })),
      });
    },
    {
      name: 'scan_markets',
      description:
        'Scan all enabled DeFi protocols (Kamino, Marginfi, Jito) for current yield opportunities.',
      schema: sc(z.object({})),
    }
  );

  const getPoolHistory = tool(
    async ({ poolId, days }: { poolId: string; days?: number }) => {
      const history = await fetchPoolHistory(poolId, config.defillamaBaseUrl);
      const recent = days ? history.slice(-days) : history;
      return JSON.stringify({ poolId, points: recent.length, data: recent });
    },
    {
      name: 'get_pool_history',
      description: 'Fetch historical APY and TVL data for a specific pool from DefiLlama.',
      schema: sc(
        z.object({
          poolId: z.string().describe('DefiLlama pool ID'),
          days: z.number().optional().describe('Recent days to return (default: all)'),
        })
      ),
    }
  );

  const getLatestOpportunities = tool(
    async ({ limit }: { limit?: number }) => {
      const opps = await db.getLatestOpportunities(limit ?? 20);
      return JSON.stringify({ count: opps.length, opportunities: opps });
    },
    {
      name: 'get_latest_opportunities',
      description: 'Retrieve the most recently scanned opportunities from the database.',
      schema: sc(
        z.object({
          limit: z.number().optional().describe('Max results to return (default: 20)'),
        })
      ),
    }
  );

  return { scanMarkets, getPoolHistory, getLatestOpportunities };
}

export type ScannerTools = ReturnType<typeof createScannerTools>;
