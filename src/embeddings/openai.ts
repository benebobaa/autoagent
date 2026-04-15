import { OpenAIEmbeddings } from '@langchain/openai';
import type { EmbeddingModel } from './interface.js';

const DIMENSION_MAP: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'text-embedding-3': 1536,
};

export class OpenAIEmbeddingModel implements EmbeddingModel {
  readonly provider = 'openai';
  readonly model: string;
  readonly dimension: number;
  private readonly client: OpenAIEmbeddings;

  constructor(model: string = 'text-embedding-3-small', apiKey?: string) {
    this.model = model;
    this.dimension = DIMENSION_MAP[model] ?? 1536;
    this.client = new OpenAIEmbeddings({ model, openAIApiKey: apiKey });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.client.embedDocuments(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.client.embedQuery(text);
  }
}
