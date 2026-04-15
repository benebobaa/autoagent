import { Connection, Keypair } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import { Wallet } from '@project-serum/anchor';
import type { AgentConfig } from '../config/loader.js';

// ---------------------------------------------------------------------------
// @solana/web3.js v1 Connection (used by Marginfi v6)
// ---------------------------------------------------------------------------

let _connection: Connection | null = null;

export function getConnection(config: AgentConfig): Connection {
  if (!_connection) {
    _connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
    });
  }
  return _connection;
}

// ---------------------------------------------------------------------------
// @solana/kit-compatible RPC (used by Kamino klend-sdk v7 and kliquidity-sdk v11)
// createSolanaRpc returns a branded union type depending on the URL pattern.
// We use ReturnType here to avoid manually narrowing the complex union.
// ---------------------------------------------------------------------------

type KitRpc = ReturnType<typeof createSolanaRpc>;

let _kitRpc: KitRpc | null = null;

export function getKitRpc(config: AgentConfig): KitRpc {
  if (!_kitRpc) {
    _kitRpc = createSolanaRpc(config.rpcUrl as Parameters<typeof createSolanaRpc>[0]);
  }
  return _kitRpc;
}

// ---------------------------------------------------------------------------
// Read-only wallet helpers
// ---------------------------------------------------------------------------

// Ephemeral keypair — never used for signing, only for SDK initialization
export function getDummyKeypair(): Keypair {
  return Keypair.generate();
}

// @project-serum/anchor Wallet (extends NodeWallet) — safe for read-only SDK operations
export function makeReadOnlyWallet(keypair: Keypair): Wallet {
  return new Wallet(keypair);
}
