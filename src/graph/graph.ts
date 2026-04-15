import { StateGraph, START, MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AgentState } from './state.js';
import { createSupervisorNode } from './supervisor.js';
import type { Database } from '../positions/db.js';
import type { RAGStore } from '../rag/store.js';
import { createAnalystAgent } from './agents/analyst.js';
import { createRiskManagerAgent } from './agents/risk-manager.js';
import { createTraderAgent } from './agents/trader.js';
import { createReporterAgent } from './agents/reporter.js';
import type { ScannerTools } from './tools/scanner-tools.js';
import type { RiskTools } from './tools/risk-tools.js';
import type { ExecutorTools } from './tools/executor-tools.js';
import type { ReporterTools } from './tools/reporter-tools.js';
import type { RagTools } from './tools/rag-tools.js';
import type { MeteoraTools } from './tools/meteora-tools.js';

export interface GraphToolDeps {
  scannerTools: ScannerTools;
  riskTools: RiskTools;
  executorTools: ExecutorTools;
  reporterTools: ReporterTools;
  ragTools: RagTools;
  meteoraTools: MeteoraTools;
}

export interface GraphDependencies {
  llm: BaseChatModel;
  llmFast?: BaseChatModel; // Optional cheaper model for reporter
  tools: GraphToolDeps;
  db: Database;
  ragStore: RAGStore;
  maxOpenPositions?: number;
}

// ---------------------------------------------------------------------------
// buildGraph — constructs and compiles the LangGraph StateGraph
// ---------------------------------------------------------------------------

export function buildGraph(deps: GraphDependencies) {
  const { llm, llmFast, tools, db, ragStore, maxOpenPositions } = deps;

  // Use MemorySaver for now — swap to SqliteSaver (persistent) in Phase 7
  const checkpointer = new MemorySaver();

  // Create agent nodes
  const supervisorNode = createSupervisorNode(llm, db, ragStore, maxOpenPositions);
  const analystNode = createAnalystAgent(llm, tools.scannerTools, tools.ragTools, tools.meteoraTools);
  const riskNode = createRiskManagerAgent(llm, tools.riskTools, tools.meteoraTools);
  const traderNode = createTraderAgent(llm, tools.executorTools);
  const reporterNode = createReporterAgent(llmFast ?? llm, tools.reporterTools);

  // Build the graph.
  // ends arrays are required by LangGraph v1.2+ when nodes use Command({ goto }) for routing.
  const graph = new StateGraph(AgentState)
    .addNode('supervisor', supervisorNode, { ends: ['analyst', 'risk', 'trader', 'reporter', '__end__'] })
    .addNode('analyst', analystNode, { ends: ['supervisor'] })
    .addNode('risk', riskNode, { ends: ['supervisor'] })
    .addNode('trader', traderNode, { ends: ['supervisor'] })
    .addNode('reporter', reporterNode, { ends: ['supervisor', '__end__'] })
    .addEdge(START, 'supervisor')
    .compile({ checkpointer });

  return graph;
}

export type InvestmentTeamGraph = ReturnType<typeof buildGraph>;
