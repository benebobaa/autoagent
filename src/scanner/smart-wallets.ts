/**
 * Smart wallet (KOL/alpha) registry.
 *
 * Wallets in this list are cross-referenced against token holders.
 * When a known KOL/fund holds a token, it boosts the pool's confidence.
 *
 * Users can extend this list via the addSmartWallet() API or by editing
 * the REGISTRY below. No external API required — purely local state.
 */

export interface SmartWallet {
  address: string;
  name: string;
  category: 'kol' | 'fund' | 'whale' | 'alpha';
}

/**
 * Seed list — add known Solana KOL/alpha wallet addresses here.
 * Leave empty if you don't want smart-wallet boosting.
 */
const REGISTRY: SmartWallet[] = [
  // Example (add real KOL addresses):
  // { address: 'SomeWalletAddressHere', name: 'AlphaTrader1', category: 'kol' },
];

let _wallets: SmartWallet[] = [...REGISTRY];

export function listSmartWallets(): SmartWallet[] {
  return _wallets;
}

export function addSmartWallet(wallet: SmartWallet): void {
  if (!_wallets.some((w) => w.address === wallet.address)) {
    _wallets.push(wallet);
  }
}

export function removeSmartWallet(address: string): void {
  _wallets = _wallets.filter((w) => w.address !== address);
}

export function isSmartWallet(address: string): boolean {
  return _wallets.some((w) => w.address === address);
}

/** Reset to seed registry (mainly for tests). */
export function resetSmartWallets(): void {
  _wallets = [...REGISTRY];
}
