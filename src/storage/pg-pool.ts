import { createHash } from 'crypto';
import { Pool } from 'pg';

let pool: Pool | null = null;

function resolveConnectionString(): string {
  const configured = process.env['VITEST']
    ? process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
    : process.env['DATABASE_URL'];
  if (!configured) {
    throw new Error('DATABASE_URL is required for PostgreSQL storage');
  }

  try {
    const parsed = new URL(configured);
    if (process.env['VITEST'] && parsed.hostname === 'postgres') {
      parsed.hostname = 'localhost';
    }
    return parsed.toString();
  } catch {
    return configured;
  }
}

function buildPool(connectionString: string, schemaName?: string): Pool {
  return new Pool({
    connectionString,
    ...(schemaName !== undefined && { options: `-c search_path=${schemaName},public` }),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function ensureExtensionInPublic(extensionName: string): Promise<void> {
  const bootstrapPool = buildPool(resolveConnectionString());
  try {
    await bootstrapPool.query(`CREATE EXTENSION IF NOT EXISTS ${extensionName} WITH SCHEMA public`);
  } finally {
    await bootstrapPool.end();
  }
}

export function getPool(): Pool {
  if (!pool) {
    pool = buildPool(resolveConnectionString());

    pool.on('error', (err) => {
      console.error('Unexpected error on idle pg client', err);
    });
  }

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function createScopedPool(scopeKey: string): { pool: Pool; schemaName: string } {
  const schemaName = `test_${createHash('sha1').update(scopeKey).digest('hex').slice(0, 16)}`;
  const scopedPool = buildPool(resolveConnectionString(), schemaName);
  scopedPool.on('error', (err) => {
    console.error('Unexpected error on scoped pg client', err);
  });
  return { pool: scopedPool, schemaName };
}
