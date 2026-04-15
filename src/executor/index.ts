import { Connection, Transaction, SystemProgram, PublicKey } from '@solana/web3.js';
import type { AgentConfig } from '../config/loader.js';
import { type Database } from '../positions/db.js';
import type { ScoredOpportunity } from '../scoring/engine.js';
import { DRY_RUN, logger } from '../utils/logger.js';
import {
  JITO_STAKE_POOL,
  STAKE_POOL_PROGRAM_ID,
  buildJitoDepositTx,
  buildJitoWithdrawTx,
  computeJitoDepositParams,
  computeJitoWithdrawParams,
  type JitoDepositParams,
  type JitoWithdrawParams,
} from './jito.js';
import {
  buildMeteoraDepositTx,
  buildMeteoraCloseTx,
  buildMeteoraClaimFeeTx,
  buildMeteoraAddLiquidityTx,
  buildMeteoraWithdrawLiquidityTx,
  computeMeteoraDepositParams,
  type MeteoraDeployParams,
  type MeteoraStrategy,
} from './meteora.js';
import { getWalletKeypair, signAndSendTransactions, isWalletConfigured } from './wallet.js';
import { buildExecutionOpportunity, ensureDlmmPositionRecord } from '../positions/dlmm-sync.js';

export type ActionType = 'open' | 'close' | 'rebalance' | 'claim_fee' | 'add_liquidity' | 'withdraw';

export interface ExecutionPlan {
  logId: string;
  positionId: string;
  action: ActionType;
  txBase64: string | null;
  txSignatures: string[];
  simSuccess: boolean | null;
  simLogs: string[];
  isDryRun: boolean;
}

/**
 * Build an unsigned transaction for a position action, simulate it, and write
 * it to the execution_log. NEVER submits the transaction automatically unless
 * AUTO_EXECUTE=true and wallet is configured.
 *
 * Jito open: builds a real depositSol instruction on the JitoSOL stake pool.
 * Jito close/rebalance: builds a real withdrawSol instruction using on-chain JitoSOL balance.
 * Meteora: builds real DLMM transactions (deploy, close, claim, add, withdraw).
 */
export async function buildExecutionPlan(
  opportunity: ScoredOpportunity,
  positionId: string,
  action: ActionType,
  connection: Connection,
  config: AgentConfig,
  db: Database,
): Promise<ExecutionPlan> {
  const position = await db.getPosition(positionId);
  const sizeUsd = position?.size_usd ?? 0;
  const storedOpportunity = position ? await db.getOpportunity(position.opportunity_id) : null;
  const fallbackOpportunity = position ? {
    id: storedOpportunity?.id ?? position.opportunity_id,
    protocol: opportunity.protocol,
    pool_id: opportunity.poolId,
    pool_name: opportunity.poolName,
    apy_defillama: opportunity.apyDefillama,
    apy_protocol: opportunity.apyProtocol,
    apy_used: opportunity.apyUsed,
    data_uncertain: opportunity.dataUncertain ? 1 : 0,
    tvl_usd: opportunity.tvlUsd,
    score: opportunity.score,
    raw_data: opportunity.raw_data ?? null,
    scanned_at: new Date().toISOString(),
  } : null;
  const executionOpportunity = position
    ? buildExecutionOpportunity(position, storedOpportunity ?? fallbackOpportunity)
    : opportunity;

  const getDlmmPosition = async () => {
    if (!position) {
      return null;
    }

    const existing = await db.getDlmmPosition(positionId);
    if (existing) {
      return existing;
    }

    if (!config.agentWalletAddress) {
      return null;
    }

    return ensureDlmmPositionRecord(db, position, config.agentWalletAddress, config.meteora.preferred_strategy);
  };

  const isJitoOpen = executionOpportunity.protocol === 'jito' && action === 'open';
  const isJitoClose = executionOpportunity.protocol === 'jito' && (action === 'close' || action === 'rebalance');
  const isMeteoraOpen = executionOpportunity.protocol === 'meteora_dlmm' && action === 'open';
  const isMeteoraClose = executionOpportunity.protocol === 'meteora_dlmm' && action === 'close';
  const isMeteoraClaimFee = executionOpportunity.protocol === 'meteora_dlmm' && action === 'claim_fee';
  const isMeteoraAddLiquidity = executionOpportunity.protocol === 'meteora_dlmm' && action === 'add_liquidity';
  const isMeteoraWithdraw = executionOpportunity.protocol === 'meteora_dlmm' && action === 'withdraw';
  const isMeteoraRebalance = executionOpportunity.protocol === 'meteora_dlmm' && action === 'rebalance';

  // -------------------------------------------------------------------------
  // DRY_RUN path
  // -------------------------------------------------------------------------
  if (DRY_RUN || config.dryRun) {
    if (isJitoOpen) {
      const jitoParams = await computeJitoDepositParams(sizeUsd);
      logger.info({ action, pool: executionOpportunity.poolId }, '[DRY_RUN] Jito depositSol (no simulation)');

      const logEntry = await db.insertExecutionLog({
        position_id: positionId,
        action,
        tx_base64: null,
        simulation_result: JSON.stringify({ dryRun: true, jito: jitoParams }),
        executed: 0,
        tx_signature: null,
      });

      printExecutionSummary({
        logId: logEntry.id,
        positionId,
        action,
        opportunity,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
        sizeUsd,
        jitoParams,
      });

      return {
        logId: logEntry.id,
        positionId,
        action,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
      };
    }

    if (isMeteoraOpen) {
      const meteoraParams = await computeMeteoraDepositParams(
        executionOpportunity.poolId,
        sizeUsd,
        (config.meteora.preferred_strategy?.toLowerCase() ?? 'spot') as MeteoraStrategy
      );
      logger.info({ action, pool: executionOpportunity.poolId }, '[DRY_RUN] Meteora DLMM deposit (no simulation)');

      const logEntry = await db.insertExecutionLog({
        position_id: positionId,
        action,
        tx_base64: null,
        simulation_result: JSON.stringify({ dryRun: true, meteora: meteoraParams }),
        executed: 0,
        tx_signature: null,
      });

      printExecutionSummary({
        logId: logEntry.id,
        positionId,
        action,
        opportunity,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
        sizeUsd,
        meteoraParams,
      });

      return {
        logId: logEntry.id,
        positionId,
        action,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
      };
    }

    if (isJitoClose) {
      const jitoWithdrawParams = await computeJitoWithdrawParams(sizeUsd, position?.entry_price_sol ?? null);
      logger.info({ action, pool: executionOpportunity.poolId }, '[DRY_RUN] Jito withdrawSol (no simulation)');

      const logEntry = await db.insertExecutionLog({
        position_id: positionId,
        action,
        tx_base64: null,
        simulation_result: JSON.stringify({ dryRun: true, jito: jitoWithdrawParams }),
        executed: 0,
        tx_signature: null,
      });

      printExecutionSummary({
        logId: logEntry.id,
        positionId,
        action,
        opportunity,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
        sizeUsd,
        jitoWithdrawParams,
      });

      return {
        logId: logEntry.id,
        positionId,
        action,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
      };
    }

    if (isMeteoraClose || isMeteoraClaimFee || isMeteoraAddLiquidity || isMeteoraWithdraw || isMeteoraRebalance) {
      const poolAddress = position?.pool_id ?? executionOpportunity.poolId;
      logger.info({ action, pool: poolAddress }, `[DRY_RUN] Meteora ${action} (no simulation)`);

      const logEntry = await db.insertExecutionLog({
        position_id: positionId,
        action,
        tx_base64: null,
        simulation_result: JSON.stringify({ dryRun: true, meteoraAction: action, pool: poolAddress }),
        executed: 0,
        tx_signature: null,
      });

      printExecutionSummary({
        logId: logEntry.id,
        positionId,
        action,
        opportunity,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
        sizeUsd,
      });

      return {
        logId: logEntry.id,
        positionId,
        action,
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
      };
    }

    // Non-Jito/Meteora DRY_RUN
    logger.info({ action, pool: executionOpportunity.poolId }, '[DRY_RUN] Skipping transaction build');

    const logEntry = await db.insertExecutionLog({
      position_id: positionId,
      action,
      tx_base64: null,
      simulation_result: JSON.stringify({ dryRun: true }),
      executed: 0,
      tx_signature: null,
    });

    printExecutionSummary({
      logId: logEntry.id,
      positionId,
      action,
      opportunity,
      txBase64: null,
      txSignatures: [],
      simSuccess: null,
      simLogs: [],
      isDryRun: true,
      sizeUsd,
    });

    return {
      logId: logEntry.id,
      positionId,
      action,
      txBase64: null,
      txSignatures: [],
      simSuccess: null,
      simLogs: [],
      isDryRun: true,
    };
  }

  // -------------------------------------------------------------------------
  // Live path — build real transaction
  // -------------------------------------------------------------------------

  const wallet = getWalletKeypair();
  const feePayerAddress = wallet?.publicKey ?? (config.agentWalletAddress ? new PublicKey(config.agentWalletAddress) : PublicKey.default);

  let txs: Transaction[] = [];
  let jitoParams: JitoDepositParams | undefined;
  let jitoWithdrawParams: JitoWithdrawParams | undefined;
  let meteoraParams: MeteoraDeployParams | undefined;

  if (isJitoOpen) {
    const result = await buildJitoDepositTx(connection, config, sizeUsd);
    txs = [result.tx];
    jitoParams = { lamports: result.lamports, solPriceUsd: result.solPriceUsd };
  } else if (isJitoClose) {
    const result = await buildJitoWithdrawTx(connection, config);
    txs = [result.tx];
    jitoWithdrawParams = { jitoSolAmount: result.jitoSolAmount, solPriceUsd: result.solPriceUsd };
  } else if (isMeteoraOpen) {
    if (!wallet) {
      logger.error('Wallet not configured for Meteora deploy');
      const fallbackTx = new Transaction({ feePayer: feePayerAddress, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash });
      fallbackTx.add(SystemProgram.transfer({ fromPubkey: feePayerAddress, toPubkey: feePayerAddress, lamports: 0 }));
      txs = [fallbackTx];
    } else {
      meteoraParams = await computeMeteoraDepositParams(
        executionOpportunity.poolId,
        sizeUsd,
        (config.meteora.preferred_strategy?.toLowerCase() ?? 'spot') as MeteoraStrategy
      );
      const result = await buildMeteoraDepositTx(meteoraParams, connection, wallet);
      txs = result?.txs ?? [];
    }
  } else if (isMeteoraClose) {
    const poolAddress = position?.pool_id ?? executionOpportunity.poolId;
    if (!wallet) {
      logger.error('Wallet not configured for Meteora close');
    } else {
      const dlmmPosition = await getDlmmPosition();
      if (!dlmmPosition) {
        logger.error({ positionId }, 'No DLMM position found for close');
      } else {
        const closeTxs = await buildMeteoraCloseTx(
          { positionPubkey: dlmmPosition.position_pubkey, poolAddress },
          connection,
          wallet
        );
        txs = closeTxs ?? [];
      }
    }
  } else if (isMeteoraClaimFee) {
    const poolAddress = position?.pool_id ?? executionOpportunity.poolId;
    if (!wallet) {
      logger.error('Wallet not configured for Meteora fee claim');
    } else {
      const dlmmPosition = await getDlmmPosition();
      if (!dlmmPosition) {
        logger.error({ positionId }, 'No DLMM position found for fee claim');
      } else {
        const claimTxs = await buildMeteoraClaimFeeTx(
          { positionPubkey: dlmmPosition.position_pubkey, poolAddress },
          connection,
          wallet
        );
        txs = claimTxs ?? [];
      }
    }
  } else if (isMeteoraAddLiquidity) {
    const poolAddress = position?.pool_id ?? executionOpportunity.poolId;
    if (!wallet) {
      logger.error('Wallet not configured for Meteora add liquidity');
    } else {
      const dlmmPosition = await getDlmmPosition();
      if (!dlmmPosition) {
        logger.error({ positionId }, 'No DLMM position found for add liquidity');
      } else {
        const addTxs = await buildMeteoraAddLiquidityTx(
          { positionPubkey: dlmmPosition.position_pubkey, poolAddress },
          connection,
          wallet
        );
        txs = addTxs ?? [];
      }
    }
  } else if (isMeteoraWithdraw) {
    const poolAddress = position?.pool_id ?? executionOpportunity.poolId;
    if (!wallet) {
      logger.error('Wallet not configured for Meteora withdraw');
    } else {
      const dlmmPosition = await getDlmmPosition();
      if (!dlmmPosition) {
        logger.error({ positionId }, 'No DLMM position found for withdraw');
      } else {
        const withdrawTxs = await buildMeteoraWithdrawLiquidityTx(
          { positionPubkey: dlmmPosition.position_pubkey, poolAddress, bps: 10000 },
          connection,
          wallet
        );
        txs = withdrawTxs ?? [];
      }
    }
  } else if (isMeteoraRebalance) {
    // Rebalance = close old + open new (two separate plan builds recommended)
    // For now, build a close tx
    const poolAddress = position?.pool_id ?? executionOpportunity.poolId;
    if (wallet) {
      const dlmmPosition = await getDlmmPosition();
      if (dlmmPosition) {
        const closeTxs = await buildMeteoraCloseTx(
          { positionPubkey: dlmmPosition.position_pubkey, poolAddress },
          connection,
          wallet
        );
        txs = closeTxs ?? [];
      }
    }
  } else {
    // Phase 1 stub for other protocols
    const fallbackTx = new Transaction();
    fallbackTx.feePayer = feePayerAddress;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    fallbackTx.recentBlockhash = blockhash;
    fallbackTx.add(SystemProgram.transfer({ fromPubkey: feePayerAddress, toPubkey: feePayerAddress, lamports: 0 }));
    txs = [fallbackTx];
  }

  if (txs.length === 0) {
    logger.warn({ action, positionId }, 'No transactions built');
  }

  // Add recent blockhash to all transactions without one
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  for (const tx of txs) {
    if (!tx.recentBlockhash) {
      tx.recentBlockhash = blockhash;
    }
    if (!tx.feePayer) {
      tx.feePayer = feePayerAddress;
    }
  }

  // Simulate all transactions
  const simResults: { success: boolean; logs: string[] }[] = [];
  for (const tx of txs) {
    try {
      const sim = await connection.simulateTransaction(tx, undefined, true);
      simResults.push({ success: sim.value.err === null, logs: sim.value.logs ?? [] });
    } catch (err) {
      simResults.push({ success: false, logs: [String(err)] });
    }
  }

  const simSuccess = simResults.every((r) => r.success);
  const simLogs = simResults.flatMap((r) => r.logs);
  const simulationResult = { err: simResults.map((r) => r.success ? null : 'simulation failed'), logs: simLogs };

  // Serialize first tx to base64
  let txBase64: string | null = null;
  if (txs.length > 0) {
    try {
      txBase64 = txs[0]!.serialize({ requireAllSignatures: false }).toString('base64');
    } catch (err) {
      logger.error({ err }, 'Failed to serialize transaction');
    }
  }

  // Auto-execute if enabled and wallet is configured
  let txSignatures: string[] = [];
  if (!DRY_RUN && !config.dryRun && wallet && txs.length > 0) {
    const autoExecute = process.env['AUTO_EXECUTE'] === 'true';
    if (autoExecute) {
      try {
        logger.info({ action, txCount: txs.length }, 'AUTO_EXECUTE enabled — signing and sending');
        txSignatures = await signAndSendTransactions(connection, txs, 'confirmed');
        logger.info({ signatures: txSignatures }, 'Transactions auto-executed');
      } catch (err) {
        logger.error({ err }, 'Auto-execution failed');
      }
    }
  }

  // Write to execution_log
  const logEntry = await db.insertExecutionLog({
    position_id: positionId,
    action,
    tx_base64: txBase64,
    simulation_result: JSON.stringify(simulationResult),
    executed: txSignatures.length > 0 ? 1 : 0,
    tx_signature: txSignatures[0] ?? null,
  });

  const plan: ExecutionPlan = {
    logId: logEntry.id,
    positionId,
    action,
    txBase64,
    txSignatures,
    simSuccess,
    simLogs,
    isDryRun: false,
  };

  printExecutionSummary({
    ...plan,
    opportunity: executionOpportunity,
    sizeUsd,
    ...(jitoParams !== undefined && { jitoParams }),
    ...(jitoWithdrawParams !== undefined && { jitoWithdrawParams }),
    ...(meteoraParams !== undefined && { meteoraParams }),
  });

  return plan;
}

// ---------------------------------------------------------------------------
// Terminal output
// ---------------------------------------------------------------------------

function printExecutionSummary(params: {
  logId: string;
  positionId: string;
  action: ActionType;
  opportunity: ScoredOpportunity;
  txBase64: string | null;
  txSignatures: string[];
  simSuccess: boolean | null;
  simLogs: string[];
  isDryRun: boolean;
  sizeUsd: number;
  jitoParams?: JitoDepositParams;
  jitoWithdrawParams?: JitoWithdrawParams;
  meteoraParams?: MeteoraDeployParams;
}): void {
  const {
    logId, positionId, action, opportunity, txBase64, txSignatures, simSuccess, simLogs, isDryRun, sizeUsd,
    jitoParams, jitoWithdrawParams, meteoraParams,
  } = params;

  console.log('\n' + '─'.repeat(60));
  console.log(`ACTION:      ${action.toUpperCase()}`);
  console.log(`POSITION ID: ${positionId}`);
  console.log(`LOG ID:      ${logId}`);
  console.log(`POOL:        ${opportunity.poolName}`);
  console.log(`PROTOCOL:    ${opportunity.protocol}`);
  console.log(`APY:         ${opportunity.apyUsed.toFixed(2)}%`);
  console.log(`SCORE:       ${opportunity.score.toFixed(1)}`);

  if (isDryRun) {
    if (jitoParams) {
      console.log('\n[DRY_RUN] Jito depositSol instruction details:');
      console.log(`  Stake Pool:   ${JITO_STAKE_POOL.toBase58()}`);
      console.log(`  Program:      ${STAKE_POOL_PROGRAM_ID.toBase58()} (Stake Pool Program)`);
      console.log(`  SOL price:    $${jitoParams.solPriceUsd.toFixed(2)}`);
      console.log(`  Size USD:     $${sizeUsd.toFixed(2)}`);
      console.log(`  Lamports:     ${jitoParams.lamports}`);
      console.log(`  SOL amount:   ${(jitoParams.lamports / 1e9).toFixed(6)} SOL`);
    } else if (jitoWithdrawParams) {
      console.log('\n[DRY_RUN] Jito withdrawSol instruction details (estimated):');
      console.log(`  Stake Pool:      ${JITO_STAKE_POOL.toBase58()}`);
      console.log(`  Program:         ${STAKE_POOL_PROGRAM_ID.toBase58()} (Stake Pool Program)`);
      console.log(`  SOL price:       $${jitoWithdrawParams.solPriceUsd.toFixed(2)}`);
      console.log(`  JitoSOL amount:  ${jitoWithdrawParams.jitoSolAmount.toFixed(6)} (estimated from entry price)`);
      console.log(`  Note: Live path fetches actual on-chain JitoSOL balance.`);
    } else if (meteoraParams) {
      console.log('\n[DRY_RUN] Meteora DLMM deposit:');
      console.log(`  Pool:         ${meteoraParams.poolAddress}`);
      console.log(`  Size USD:     $${sizeUsd.toFixed(2)}`);
      console.log(`  Strategy:     ${meteoraParams.strategy}`);
      console.log(`  Bins below:   ${meteoraParams.binsBelow}`);
      console.log(`  Bins above:   ${meteoraParams.binsAbove}`);
    } else {
      console.log('\n[DRY_RUN MODE] No transaction was built or simulated.');
      console.log('Set DRY_RUN=false in .env to enable transaction building.');
    }
  } else {
    if (txSignatures.length > 0) {
      console.log(`\nAUTO-EXECUTED: ${txSignatures.length} transaction(s):`);
      txSignatures.forEach((sig, i) => console.log(`  [${i + 1}] ${sig}`));
    }

    if (jitoParams) {
      console.log(`\nJITO DEPOSIT:`);
      console.log(`  SOL price:  $${jitoParams.solPriceUsd.toFixed(2)}`);
      console.log(`  Lamports:   ${jitoParams.lamports}`);
      console.log(`  SOL amount: ${(jitoParams.lamports / 1e9).toFixed(6)} SOL`);
    } else if (jitoWithdrawParams) {
      console.log(`\nJITO WITHDRAW:`);
      console.log(`  SOL price:       $${jitoWithdrawParams.solPriceUsd.toFixed(2)}`);
      console.log(`  JitoSOL amount:  ${jitoWithdrawParams.jitoSolAmount.toFixed(6)} (full on-chain balance)`);
    } else if (meteoraParams) {
      console.log('\nMETEORA DLMM DEPOSIT:');
      console.log(`  Pool:       ${meteoraParams.poolAddress}`);
      console.log(`  Size USD:   $${sizeUsd.toFixed(2)}`);
      console.log(`  Strategy:   ${meteoraParams.strategy}`);
      console.log(`  Bin range:  ${meteoraParams.binsBelow} below / ${meteoraParams.binsAbove} above`);
    }

    console.log(`\nSIMULATION:  ${simSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
    if (simLogs.length > 0) {
      console.log('\nSimulation logs:');
      simLogs.slice(0, 10).forEach((log) => console.log(`  ${log}`));
    }

    if (txBase64) {
      console.log('\n' + '─'.repeat(60));
      console.log('UNSIGNED TRANSACTION (base64):');
      console.log(txBase64);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log('NEXT STEPS:');
  if (txSignatures.length > 0) {
    console.log('✅ Transaction(s) auto-executed on-chain.');
  } else {
    console.log('1. Review the simulation result above.');
    console.log('2. If satisfied, sign the transaction in your wallet (e.g. Phantom)');
    console.log('   using the base64 string above.');
    console.log('3. After signing and broadcasting, confirm with:');
    console.log(`   npm run cli -- confirm --position=${positionId} --signature=<txSignature>`);
  }
  console.log('─'.repeat(60) + '\n');
}
