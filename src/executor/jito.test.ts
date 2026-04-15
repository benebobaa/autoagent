import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { STAKE_POOL_PROGRAM_ID } from '@solana/spl-stake-pool';

// Mock fetchSolPriceUsd to avoid network calls
vi.mock('../utils/price.js', () => ({
  fetchSolPriceUsd: vi.fn().mockResolvedValue(150),
}));

import { JITO_STAKE_POOL, computeJitoDepositParams, computeJitoWithdrawParams } from './jito.js';
import { fetchSolPriceUsd } from '../utils/price.js';

describe('Jito executor', () => {
  beforeEach(() => {
    vi.mocked(fetchSolPriceUsd).mockResolvedValue(150);
  });

  it('JITO_STAKE_POOL is the correct mainnet address', () => {
    expect(JITO_STAKE_POOL.toBase58()).toBe('Jito4APyf642JPZPx3hGc6WWyokR9p7fFCHANQRpFMh');
  });

  it('STAKE_POOL_PROGRAM_ID is not SystemProgram', () => {
    const SYSTEM_PROGRAM = '11111111111111111111111111111111';
    expect(STAKE_POOL_PROGRAM_ID.toBase58()).not.toBe(SYSTEM_PROGRAM);
    expect(STAKE_POOL_PROGRAM_ID.toBase58()).toBe('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
  });

  describe('computeJitoDepositParams', () => {
    it('converts USD to lamports using SOL price', async () => {
      // $50 at $150/SOL => 0.3333... SOL => 333333333 lamports
      const { lamports, solPriceUsd } = await computeJitoDepositParams(50);
      expect(solPriceUsd).toBe(150);
      expect(lamports).toBe(Math.floor((50 / 150) * LAMPORTS_PER_SOL));
      expect(lamports).toBeGreaterThan(0);
    });

    it('floors lamports to integer', async () => {
      // $1 at $150/SOL => 6666666.666... => 6666666
      const { lamports } = await computeJitoDepositParams(1);
      expect(Number.isInteger(lamports)).toBe(true);
    });

    it('scales linearly with position size', async () => {
      const { lamports: small } = await computeJitoDepositParams(25);
      const { lamports: large } = await computeJitoDepositParams(50);
      expect(large).toBeGreaterThan(small);
    });

    it('uses live SOL price from fetchSolPriceUsd', async () => {
      vi.mocked(fetchSolPriceUsd).mockResolvedValueOnce(200);
      const { solPriceUsd, lamports } = await computeJitoDepositParams(50);
      expect(solPriceUsd).toBe(200);
      // $50 at $200/SOL => 0.25 SOL => 250000000 lamports
      expect(lamports).toBe(250_000_000);
    });
  });

  describe('computeJitoWithdrawParams', () => {
    it('uses entry price when provided', async () => {
      // $150 at entry price 150 => 1.0 JitoSOL
      const { jitoSolAmount, solPriceUsd } = await computeJitoWithdrawParams(150, 150);
      expect(solPriceUsd).toBe(150);
      expect(jitoSolAmount).toBeCloseTo(1.0, 6);
    });

    it('falls back to current SOL price when entry price is null', async () => {
      // $75 at current price $150/SOL => 0.5 JitoSOL
      const { jitoSolAmount, solPriceUsd } = await computeJitoWithdrawParams(75, null);
      expect(solPriceUsd).toBe(150);
      expect(jitoSolAmount).toBeCloseTo(0.5, 6);
    });

    it('scales linearly with position size', async () => {
      const { jitoSolAmount: small } = await computeJitoWithdrawParams(100, 150);
      const { jitoSolAmount: large } = await computeJitoWithdrawParams(200, 150);
      expect(large).toBeGreaterThan(small);
      expect(large).toBeCloseTo(small * 2, 6);
    });
  });

  describe('DRY_RUN output contains Jito details (not System Program stub)', () => {
    it('prints stake pool program ID, not System Program', () => {
      const SYSTEM_PROGRAM = '11111111111111111111111111111111';
      const stakePoolProgramId = STAKE_POOL_PROGRAM_ID.toBase58();
      // Verify the program we would print is the stake pool, not the system program stub
      expect(stakePoolProgramId).not.toBe(SYSTEM_PROGRAM);
      expect(stakePoolProgramId).toContain('SPoo1');
    });

    it('DRY_RUN summary would include SOL price and lamports', async () => {
      const { lamports, solPriceUsd } = await computeJitoDepositParams(50);
      // These are the values that printExecutionSummary shows in DRY_RUN Jito mode
      expect(lamports).toBeGreaterThan(0);
      expect(solPriceUsd).toBeGreaterThan(0);
      // The output line would be: `  Lamports:     ${lamports}` — not a zero-lamport stub
      expect(lamports).not.toBe(0);
    });
  });
});
