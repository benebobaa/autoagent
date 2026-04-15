import type { Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import type { AgentConfig } from '../../config/loader.js';
import type { Database } from '../../positions/db.js';
import type { TelegramReporter } from '../../reporter/telegram.js';
import type { RAGStore } from '../../rag/store.js';
import { createScannerTools } from './scanner-tools.js';
import { createRiskTools } from './risk-tools.js';
import { createExecutorTools } from './executor-tools.js';
import { createReporterTools } from './reporter-tools.js';
import { createRagTools } from './rag-tools.js';
import { createSwapTools } from './swap-tools.js';

type KitRpc = ReturnType<typeof createSolanaRpc>;

// ---------------------------------------------------------------------------
// Tool registry — creates all LangGraph tools and groups them by agent role
// ---------------------------------------------------------------------------

export interface ToolDependencies {
  config: AgentConfig;
  db: Database;
  connection: Connection;
  kitRpc: KitRpc;
  reporter: TelegramReporter;
  ragStore: RAGStore;
}

export function createAllTools(deps: ToolDependencies) {
  const scanner = createScannerTools(deps.config, deps.db, deps.connection, deps.kitRpc);
  const risk = createRiskTools(deps.config, deps.db, deps.connection, deps.kitRpc, deps.ragStore);
  const executor = createExecutorTools(deps.config, deps.db, deps.connection, deps.ragStore);
  const reporterTools = createReporterTools(deps.db, deps.reporter);
  const rag = createRagTools(deps.ragStore);
  const swap = createSwapTools(deps.config, deps.connection);

  return {
    // Tools grouped by agent role
    scannerTools: [
      scanner.scanMarkets,
      scanner.getPoolHistory,
      scanner.getLatestOpportunities,
      rag.getProtocolInfoTool,
    ],

    riskTools: [
      risk.scoreOpportunityTool,
      risk.computePortfolioPnl,
      risk.checkSignals,
      risk.getMarketRegime,
      risk.recallPastDecisions,
    ],

    traderTools: [
      executor.listPositions,
      executor.createPosition,
      executor.buildExecutionPlanTool,
      executor.transitionPosition,
    ],

    swapTools: swap.getSwapQuote && swap.executeSwap && swap.getWalletBalances
      ? [swap.getSwapQuote, swap.executeSwap, swap.getWalletBalances]
      : [],

    reporterTools: [
      reporterTools.sendTelegramMessage,
      reporterTools.formatDailyReportTool,
      reporterTools.sendDailyReportTool,
    ],

    ragTools: [
      rag.searchKnowledgeBaseTool,
      rag.getProtocolInfoTool,
      rag.recallPastDecisionsTool,
    ],
  };
}

export type AllTools = ReturnType<typeof createAllTools>;

// Re-export individual factory functions for selective use
export { createScannerTools, createRiskTools, createExecutorTools, createReporterTools, createRagTools, createSwapTools };
