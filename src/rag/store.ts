import type { QueryResultRow } from 'pg';
import type { AgentConfig } from '../config/loader.js';
import type { EmbeddingModel } from '../embeddings/interface.js';
import { getPool } from '../storage/pg-pool.js';
import type { VectorDocument, VectorMetadata, VectorQueryResult, VectorWhere } from '../storage/types.js';
import { logger } from '../utils/logger.js';

export interface RAGDocument extends VectorDocument {}

export interface RAGQueryResult extends VectorQueryResult {}

function isAndWhere(where: VectorWhere): where is { $and: VectorWhere[] } {
  return '$and' in where && Array.isArray(where.$and);
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

function buildWhereClause(where: VectorWhere | undefined, startIndex = 1): { sql: string; params: unknown[] } {
  if (!where) {
    return { sql: '', params: [] };
  }

  if (isAndWhere(where)) {
    const parts: string[] = [];
    const params: unknown[] = [];
    let index = startIndex;

    for (const clause of where.$and) {
      const built = buildWhereClause(clause, index);
      if (built.sql) {
        parts.push(`(${built.sql})`);
        params.push(...built.params);
        index += built.params.length;
      }
    }

    return { sql: parts.join(' AND '), params };
  }

  const parts: string[] = [];
  const params: unknown[] = [];
  let index = startIndex;

  for (const [key, condition] of Object.entries(where)) {
    parts.push(`metadata @> $${index}::jsonb`);
    params.push(JSON.stringify({ [key]: condition.$eq }));
    index += 1;
  }

  return { sql: parts.join(' AND '), params };
}

function normalizeRow<T extends QueryResultRow>(row: T): T {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return normalized as T;
}

export class RAGStore {
  private available = false;

  constructor(
    private readonly _config: AgentConfig,
    private readonly embeddingModel: EmbeddingModel,
  ) {}

  async init(): Promise<void> {
    try {
      await getPool().query('SELECT 1');
      this.available = true;
      logger.info(
        {
          provider: this.embeddingModel.provider,
          model: this.embeddingModel.model,
          dimension: this.embeddingModel.dimension,
        },
        'RAG store initialized'
      );
    } catch (err) {
      this.available = false;
      logger.warn({ err }, 'RAG store unavailable — running without memory (degraded mode)');
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  async upsert(documents: RAGDocument[]): Promise<void> {
    if (!this.available || documents.length === 0) return;

    const embeddings = await this.embeddingModel.embed(documents.map((document) => document.text));
    for (const [index, document] of documents.entries()) {
      const embedding = embeddings[index];
      if (!embedding) continue;

      await getPool().query(
        `INSERT INTO rag_documents (id, document, metadata, embedding, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::vector, NOW())
         ON CONFLICT (id) DO UPDATE
         SET document = EXCLUDED.document,
             metadata = EXCLUDED.metadata,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
        [document.id, document.text, JSON.stringify(document.metadata), vectorLiteral(embedding)]
      );
    }

    logger.debug({ count: documents.length }, 'RAG documents upserted');
  }

  async query(queryText: string, opts: { n?: number; where?: VectorWhere } = {}): Promise<RAGQueryResult[]> {
    if (!this.available) return [];

    const queryEmbedding = await this.embeddingModel.embedQuery(queryText);
    const n = opts.n ?? 5;
    const whereClause = buildWhereClause(opts.where, 3);
    const sql = [
      `SELECT id, document as text, metadata, (embedding <=> $1::vector) as distance`,
      `FROM rag_documents`,
      whereClause.sql ? `WHERE ${whereClause.sql}` : '',
      `ORDER BY embedding <=> $1::vector`,
      `LIMIT $2`,
    ].filter(Boolean).join(' ');

    const rows = await getPool().query<{
      id: string;
      text: string;
      metadata: VectorMetadata;
      distance: number;
    }>(sql, [vectorLiteral(queryEmbedding), n, ...whereClause.params]);

    return rows.rows.map((row) => normalizeRow(row));
  }

  async count(): Promise<number> {
    if (!this.available) return 0;
    const result = await getPool().query<{ count: string }>('SELECT COUNT(*)::text as count FROM rag_documents');
    return Number(result.rows[0]?.count ?? 0);
  }

  async deleteByMetadata(filter: VectorWhere): Promise<void> {
    if (!this.available) return;
    const whereClause = buildWhereClause(filter, 1);
    if (!whereClause.sql) return;
    await getPool().query(`DELETE FROM rag_documents WHERE ${whereClause.sql}`, whereClause.params);
  }
}
