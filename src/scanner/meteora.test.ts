import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { fetchMeteoraOpportunities } from './meteora.js';
import type { AgentConfig } from '../config/loader.js';
import type { DefiLlamaPool } from './defillama.js';

vi.mock('axios');

const mockConfig: AgentConfig = {
  meteora: {
    enabled: true,
    min_tvl_usd: 100000,
    min_fee_apr: 0.1,
    allowed_pairs: ['SOL-USDC'],
    bin_step_rules: {
      stablecoin_pairs: { max_bin_step: 10 },
      bluechip_pairs: { max_bin_step: 50 },
      volatile_pairs: { max_bin_step: 150 },
    },
    active_bin_liquidity_min_pct: 0.15,
    discovery: {} as any,
  },
  meteoraApiBaseUrl: 'https://dlmm.datapi.meteora.ag',
  scoring: { data_uncertainty_threshold_pct: 15 },
  logLevel: 'info',
} as unknown as AgentConfig;

describe('fetchMeteoraOpportunities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('fetches and maps Meteora pools successfully', async () => {
    // Mock axios response — new paginated format from dlmm.datapi.meteora.ag
    const mockApiResponse = {
      pages: 1,
      current_page: 1,
      page_size: 100,
      data: [{
        address: 'pool123',
        name: 'SOL-USDC',
        token_x: { address: 'sol', symbol: 'SOL', decimals: 9, price: 150 },
        token_y: { address: 'usdc', symbol: 'USDC', decimals: 6, price: 1 },
        pool_config: { bin_step: 20, base_fee_pct: 0.1, max_fee_pct: 0, protocol_fee_pct: 5 },
        tvl: 1000000,
        apr: 0.5475, // 54.75% APR
        apy: 0,
        volume: { '24h': 500000 },
        fees: { '24h': 1500 },
        current_price: 150.5,
      }],
    };

    // Typecast to any to satisfy TS for the mock implementation
    (axios.get as any).mockResolvedValueOnce({ data: mockApiResponse });

    const llamaPools = new Map<string, DefiLlamaPool>();
    llamaPools.set('sol-usdc-meteora', {
      pool: 'sol-usdc-meteora',
      project: 'meteora-dlmm',
      symbol: 'SOL-USDC',
      tvlUsd: 1000000,
      apy: 5.5,
    } as DefiLlamaPool);

    const result = await fetchMeteoraOpportunities(llamaPools, mockConfig);

    expect(result).toHaveLength(1);
    expect(result[0]?.poolId).toBe('pool123');
    expect(result[0]?.protocol).toBe('meteora_dlmm');
    expect(result[0]?.tvlUsd).toBe(1000000);
    // fee_apr = (1500 / 1000000) * 365 = 0.5475 => 54.75%
    expect(result[0]?.apyProtocol).toBeCloseTo(54.75, 2);
    expect(result[0]?.dataUncertain).toBe(true); // Huge difference between 54.75% and 5.5% DefiLlama apy
  });

  it('uses DefiLlama fallback on 404', async () => {
    // The code retries 3 times, each with a delay. We need to mock the delay.
    const promise = fetchMeteoraOpportunities(new Map([
      ['sol-usdc-meteora', {
        pool: 'fallback-pool',
        project: 'meteora-dlmm',
        symbol: 'SOL-USDC',
        tvlUsd: 500000,
        apy: 12.0,
      } as DefiLlamaPool]
    ]), mockConfig);
    
    // Advance timers so the sleep() resolves immediately
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toHaveLength(1);
    expect(result[0]?.poolId).toBe('fallback-pool');
    expect(result[0]?.dataUncertain).toBe(true); // Force flagged
    expect(result[0]?.apyUsed).toBe(12.0);
  });
  
  it('skips pools not in allowed_pairs', async () => {
    (axios.get as any).mockResolvedValueOnce({ data: {
      pages: 1,
      current_page: 1,
      page_size: 100,
      data: [{
        address: 'pool999',
        name: 'WEN-SOL',
        token_x: { address: 'wen', symbol: 'WEN', decimals: 6, price: 0.001 },
        token_y: { address: 'sol', symbol: 'SOL', decimals: 9, price: 150 },
        pool_config: { bin_step: 80, base_fee_pct: 1.0, max_fee_pct: 0, protocol_fee_pct: 5 },
        tvl: 1000000,
        apr: 0.5,
        apy: 0,
        volume: { '24h': 100000 },
        fees: { '24h': 1000 },
        current_price: 0.001,
      }],
    }});

    const result = await fetchMeteoraOpportunities(new Map(), mockConfig);
    expect(result).toHaveLength(0);
  });
});
