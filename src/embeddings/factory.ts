import type { AgentConfig } from '../config/loader.js';
import type { EmbeddingModel } from './interface.js';
import { OpenAIEmbeddingModel } from './openai.js';
import { logger } from '../utils/logger.js';

export function createEmbeddingModel(config: AgentConfig): EmbeddingModel {
  const apiKey = config.embeddingApiKey ?? config.openaiApiKey;
  if (!apiKey) {
    logger.warn('No embedding API key configured. RAG queries will fail if invoked.');
  }

  return new OpenAIEmbeddingModel(config.rag.embedding_model, apiKey);
}
