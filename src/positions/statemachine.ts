import type { AgentConfig } from '../config/loader.js';
import { type Database, type Position, type PositionState } from './db.js';
import { logger } from '../utils/logger.js';
import { classifyPool, getExposureByGroup, checkConcentrationRisk } from '../scoring/correlation.js';

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<PositionState, PositionState[]> = {
  PENDING_OPEN: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['PENDING_REBALANCE', 'PENDING_CLOSE', 'CLOSED'],
  PENDING_REBALANCE: ['ACTIVE', 'PENDING_CLOSE'],
  PENDING_CLOSE: ['CLOSED'],
  CLOSED: [],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  txSignature?: string;
  closeReason?: 'manual' | 'rebalance' | 'circuit_breaker' | 'apy_drop'
    | 'stop_loss' | 'take_profit' | 'trailing_take_profit' | 'time_stop' | 'out_of_range' | 'rug_detected'
    | 'oor_timeout' | 'fee_yield_low' | 'pumped_past_range';
  notes?: string;
}

export interface TransitionResult {
  success: boolean;
  error?: string;
  newState?: PositionState;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export class PositionStateMachine {
  constructor(
    private readonly db: Database,
    private readonly config: AgentConfig
  ) {}

  async transition(
    positionId: string,
    targetState: PositionState,
    opts: TransitionOptions = {}
  ): Promise<TransitionResult> {
    const position = await this.db.getPosition(positionId);
    if (!position) {
      return { success: false, error: `Position ${positionId} not found` };
    }

    const validation = await this.validate(position, targetState, opts);
    if (!validation.success) return validation;

    const now = new Date().toISOString();
    const stateOpts: Parameters<Database['updatePositionState']>[2] = {};
    if (opts.txSignature !== undefined) stateOpts.tx_signature = opts.txSignature;
    if (targetState === 'ACTIVE') stateOpts.opened_at = now;
    if (targetState === 'CLOSED') stateOpts.closed_at = now;
    if (opts.closeReason !== undefined) stateOpts.close_reason = opts.closeReason;
    await this.db.updatePositionState(positionId, targetState, stateOpts);

    logger.info(
      { positionId, from: position.state, to: targetState },
      'Position state transition'
    );

    return { success: true, newState: targetState };
  }

  private async validate(
    position: Position,
    targetState: PositionState,
    opts: TransitionOptions
  ): Promise<TransitionResult> {
    const from = position.state;

    // Guard: valid transition path
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(targetState)) {
      return {
        success: false,
        error: `Invalid transition: ${from} → ${targetState}. Allowed: ${allowed.join(', ') || 'none'}`,
      };
    }

    // Guard: ACTIVE requires tx_signature
    if (targetState === 'ACTIVE' && !opts.txSignature) {
      return {
        success: false,
        error: 'Cannot transition to ACTIVE without a tx_signature',
      };
    }

    // Guard: cannot open new positions if max_open_positions exceeded
    if (targetState === 'ACTIVE' && from === 'PENDING_OPEN') {
      const activeCount = await this.db.countActivePositions();
      const max = this.config.position.max_open_positions;
      if (activeCount >= max) {
        return {
          success: false,
          error: `Circuit breaker: max open positions (${max}) already reached (${activeCount} active)`,
        };
      }

      // Guard: position size cap
      if (position.size_usd > this.config.position.max_position_usd) {
        return {
          success: false,
          error: `Position size $${position.size_usd} exceeds max allowed $${this.config.position.max_position_usd}`,
        };
      }
    }

    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// Guard: validate a new position before inserting
// ---------------------------------------------------------------------------

export async function validateNewPosition(
  sizeUsd: number,
  config: AgentConfig,
  db: Database,
  protocol: string,
  poolName: string,
  poolId?: string,
  baseMint?: string | null,
): Promise<TransitionResult> {
  if (poolId !== undefined) {
    const cooldown = await db.getActivePoolCooldown(poolId);
    if (cooldown) {
      return {
        success: false,
        error: `Pool ${poolId} is on cooldown until ${cooldown.cooldown_until} (${cooldown.reason})`,
      };
    }

    const activeInPool = (await db.getPositionsByState('ACTIVE')).filter((p) => p.pool_id === poolId);
    if (activeInPool.length > 0) {
      return {
        success: false,
        error: `Pool ${poolId} already has an active position — skipping duplicate`,
      };
    }
  }

  if (sizeUsd < config.position.min_position_usd) {
    return {
      success: false,
      error: `Size $${sizeUsd} is below minimum $${config.position.min_position_usd}`,
    };
  }
  if (sizeUsd > config.position.max_position_usd) {
    return {
      success: false,
      error: `Size $${sizeUsd} exceeds maximum $${config.position.max_position_usd}`,
    };
  }
  const activeCount = await db.countActivePositions();
  if (activeCount >= config.position.max_open_positions) {
    return {
      success: false,
      error: `Max open positions (${config.position.max_open_positions}) reached`,
    };
  }

  const activePositions = await db.getPositionsByState('ACTIVE');
  if (baseMint != null) {
    const activeWithMint = activePositions.filter((position) => position.base_mint === baseMint);
    if (activeWithMint.length > 0) {
      return {
        success: false,
        error: `Base mint ${baseMint} already has an active position — skipping duplicate token exposure`,
      };
    }
  }

  const group = classifyPool(protocol, poolName);
  const currentExposure = getExposureByGroup(activePositions);
  const totalCapitalUsd = config.paperTrading
    ? config.paperStartingBalanceUsd
    : activePositions.reduce((sum, p) => sum + p.size_usd, 0) + sizeUsd;

  const concentration = checkConcentrationRisk({
    currentExposure,
    newPosition: { group, sizeUsd },
    maxGroupConcentrationPct: config.position.max_group_concentration_pct,
    totalCapitalUsd,
  });
  if (!concentration.allowed) {
    return { success: false, error: concentration.reason };
  }

  return { success: true };
}
