import { describe, expect, it } from 'vitest';
import { ActiveDlmmDetector } from './active-dlmm-detector.js';

describe('ActiveDlmmDetector', () => {
  it('deduplicates the same pool during cooldown', async () => {
    const detector = new ActiveDlmmDetector(
      {
        batchPoolSnapshots: async () => [
          {
            poolAddress: 'pool-1',
            tokenSymbol: 'MEME',
            priceUsd: 1.25,
            priceChange24hPct: 20,
            priceChangeBaselinePct: 2,
            volumeSpikeRatio: 10,
            liquidityUsd: 100000,
            timestamp: Date.now(),
          },
        ],
      } as never,
      { getTrendingSolanaPools: async () => [] } as never,
    );

    const first = await detector.scanForVolumeSpikes([{ poolId: 'pool-1', tokenMint: 'mint-abc' }]);
    const second = await detector.scanForVolumeSpikes([{ poolId: 'pool-1', tokenMint: 'mint-abc' }]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
