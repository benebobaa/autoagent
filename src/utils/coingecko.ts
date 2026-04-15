import { logger } from './logger.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

const cache = new Map<string, { data: unknown; expiry: number }>();

interface CoinGeckoMarketItem {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d: number;
  total_volume: number;
  market_cap: number;
}

interface CoinGeckoChartPoint {
  prices: [number, number][];
  volumes: [number, number][];
}

interface SolPriceHistoryPoint {
  timestamp: string;
  priceUsd: number;
  volume?: number;
}

interface SolPriceHistory {
  points: SolPriceHistoryPoint[];
  fetchedAt: string;
  currency: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

async function coingeckoFetch<T>(url: string, cacheKey: string): Promise<T> {
  const cached = cache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.data as T;
  }

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!resp.ok) {
      throw new Error(`CoinGecko API error: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json() as T;
    cache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.error({ err, url }, 'CoinGecko fetch failed');
    throw err;
  }
}

export async function fetchSolPriceHistory(
  days = 7
): Promise<SolPriceHistory> {
  const url = `${COINGECKO_BASE}/coins/solana/market_chart?vs_currency=usd&days=${days}&interval=hourly`;

  const data = await coingeckoFetch<CoinGeckoChartPoint>(url, `sol_history_${days}`);

  const points: SolPriceHistoryPoint[] = data.prices.map(([timestamp, priceUsd]) => {
    const volumeEntry = data.volumes?.find(
      ([volTs]) => Math.abs(volTs - timestamp) < 60 * 60 * 1000
    );
    const point: SolPriceHistoryPoint = {
      timestamp: new Date(timestamp).toISOString(),
      priceUsd,
    };
    if (volumeEntry) {
      point.volume = volumeEntry[1];
    }
    return point;
  });

  return {
    points,
    fetchedAt: new Date().toISOString(),
    currency: 'usd',
  };
}

export async function fetchSolCurrentPrice(): Promise<number> {
  const url = `${COINGECKO_BASE}/coins/solana?localization=false&tickers=false&community_data=false&developer_data=false`;

  interface CoinGeckoCoin {
    market_data: { current_price: { usd: number } };
  }

  const data = await coingeckoFetch<CoinGeckoCoin>(url, 'sol_current');
  return data.market_data.current_price.usd;
}

export function clearCoingeckoCache(): void {
  cache.clear();
}
