import { describe, it, expect, vi } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

vi.mock('@meteora-ag/dlmm', () => {
  return {
    default: {
      create: vi.fn(),
    }
  };
});

import { computeMeteoraDepositParams, buildMeteoraDepositTx, calculateTargetBinRange } from './meteora.js';

describe('Meteora Executor', () => {
  it('computes deposit params', async () => {
    const params = await computeMeteoraDepositParams('pool123', 5000, 'curve');
    expect(params.poolAddress).toBe('pool123');
    expect(params.initialValueUsd).toBe(5000);
    expect(params.strategy).toBe('curve');
  });

  it('calculates target bin range based on strategy and volatility', () => {
    const spot = calculateTargetBinRange(1000, 'spot', 10, 1);
    expect(spot.lowerBinId).toBeLessThan(1000);
    expect(spot.upperBinId).toBeGreaterThan(1000);

    const curve = calculateTargetBinRange(1000, 'curve', 10, 1);
    expect(curve.lowerBinId).toBeLessThan(1000);
    expect(curve.upperBinId).toBeGreaterThan(1000);
  });

  it('returns null for invalid pool address', async () => {
    const connection = new Connection('http://localhost:8899');
    const wallet = Keypair.generate();

    const result = await buildMeteoraDepositTx(
      { poolAddress: 'invalid_pool_address_that_wont_parse', amountX: 0, amountY: 0, strategy: 'spot', binsBelow: 30, binsAbove: 30 },
      connection,
      wallet
    );

    expect(result).toBeNull();
  });
});
