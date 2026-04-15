import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RAGStore } from '../../rag/store.js';
import { searchKnowledgeBase, queryProtocolInfo, queryPastDecisions } from '../../rag/query.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = <T extends z.ZodRawShape>(s: z.ZodObject<T>): any => s;

export function createRagTools(ragStore: RAGStore) {
  const searchKnowledgeBaseTool = tool(
    async ({ query, k }: { query: string; k?: number }) => {
      try {
        const results = await searchKnowledgeBase(ragStore, query, k ?? 5);
        return JSON.stringify({ count: results.length, results: results.map((r) => ({ text: r.text, metadata: r.metadata })) });
      } catch {
        return JSON.stringify({ count: 0, results: [], message: 'RAG store unavailable' });
      }
    },
    {
      name: 'search_knowledge_base',
      description: 'Search the knowledge base (protocol docs + past decisions + PnL history) with a free-text query.',
      schema: sc(z.object({
        query: z.string().describe('Free text search query'),
        k: z.number().optional().describe('Max results (default: 5)'),
      })),
    }
  );

  const getProtocolInfoTool = tool(
    async ({ protocol, topic }: { protocol: string; topic: string }) => {
      try {
        const results = await queryProtocolInfo(ragStore, protocol, topic);
        if (results.length === 0) {
          return JSON.stringify({ message: `No docs found for ${protocol} on topic: ${topic}` });
        }
        return JSON.stringify({ results: results.map((r) => r.text) });
      } catch {
        return JSON.stringify({ message: 'RAG store unavailable' });
      }
    },
    {
      name: 'get_protocol_info',
      description: 'Retrieve protocol documentation for a specific topic (e.g. risk profile, key metrics, position management guidelines).',
      schema: sc(z.object({
        protocol: z.string().describe('Protocol name (e.g. jito, kamino_lending, marginfi)'),
        topic: z.string().describe('Topic to search for (e.g. "liquidation risk", "APY source", "exit strategy")'),
      })),
    }
  );

  const recallPastDecisionsTool = tool(
    async ({ signalTypes, k }: { signalTypes: string[]; k?: number }) => {
      try {
        const results = await queryPastDecisions(ragStore, signalTypes, k ?? 3);
        if (results.length === 0) {
          return JSON.stringify({ message: 'No past decisions found', results: [] });
        }
        return JSON.stringify({
          count: results.length,
          results: results.map((r) => ({
            text: r.text,
            metadata: r.metadata,
            relevance: (1 - r.distance).toFixed(3),
          })),
        });
      } catch {
        return JSON.stringify({ message: 'RAG store unavailable', results: [] });
      }
    },
    {
      name: 'recall_past_decisions',
      description: 'Recall past agent decisions made in response to similar signal types, to inform current reasoning.',
      schema: sc(z.object({
        signalTypes: z.array(z.string()).describe('Signal types to search for, e.g. ["APY_DRIFT"]'),
        k: z.number().optional().describe('Max results (default: 3)'),
      })),
    }
  );

  return { searchKnowledgeBaseTool, getProtocolInfoTool, recallPastDecisionsTool };
}

export type RagTools = ReturnType<typeof createRagTools>;
