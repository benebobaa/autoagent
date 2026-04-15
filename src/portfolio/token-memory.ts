import type { ScoredOpportunity } from '../scoring/engine.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractBaseMintFromRawData(rawData: unknown): string | null {
  if (rawData === null || rawData === undefined) {
    return null;
  }

  let parsed: unknown = rawData;
  if (typeof rawData === 'string') {
    try {
      parsed = JSON.parse(rawData) as unknown;
    } catch {
      return null;
    }
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const explicitBaseMint = parsed['baseMint'];
  if (typeof explicitBaseMint === 'string' && explicitBaseMint.length > 0) {
    return explicitBaseMint;
  }

  const tokenAMint = parsed['tokenAMint'];
  if (typeof tokenAMint === 'string' && tokenAMint.length > 0) {
    return tokenAMint;
  }

  return null;
}

export function extractBaseMintFromOpportunity(opportunity: Pick<ScoredOpportunity, 'raw_data'>): string | null {
  return extractBaseMintFromRawData(opportunity.raw_data ?? null);
}
