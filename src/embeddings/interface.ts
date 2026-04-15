export interface EmbeddingModel {
  readonly provider: string;
  readonly model: string;
  readonly dimension: number;

  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
