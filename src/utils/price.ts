import axios from 'axios';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

export async function fetchSolPriceUsd(): Promise<number> {
  const res = await axios.get<{ solana: { usd: number } }>(COINGECKO_URL, { timeout: 10_000 });
  const price = res.data?.solana?.usd;
  if (!price || price <= 0) {
    throw new Error(`Invalid SOL price from CoinGecko: ${JSON.stringify(res.data)}`);
  }
  return price;
}
