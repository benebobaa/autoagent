import type { DecisionEpisode, DecisionGrade, DecisionOutcome, SkipEpisode } from './decision-types.js';

// ---------------------------------------------------------------------------
// Decision Grader — pure function, deterministic, zero-cost
// ---------------------------------------------------------------------------
// Grades each decision episode based on quantitative metrics.
// Rule-based only (no LLM). Testable. Auditable.
// ---------------------------------------------------------------------------

const GAS_COST_ESTIMATE_USD = 0.002; // ~2 txns (open+close) at ~$0.001 each

// ---------------------------------------------------------------------------
// Grade open/close decisions (positions that reached an outcome)
// ---------------------------------------------------------------------------

export function gradeDecision(episode: DecisionEpisode): DecisionGrade {
  if (!episode.outcome) return 'NEUTRAL'; // No outcome yet

  const { outcome } = episode;

  if (episode.action === 'open') {
    return gradeOpenDecision(episode, outcome);
  }

  if (episode.action === 'close') {
    return gradeCloseDecision(episode, outcome);
  }

  if (episode.action === 'hold') {
    return gradeHoldDecision(outcome);
  }

  if (episode.action === 'rebalance') {
    return gradeRebalanceDecision(outcome);
  }

  // skip decisions are graded separately via gradeSkipDecision
  return 'NEUTRAL';
}

function gradeOpenDecision(episode: DecisionEpisode, outcome: DecisionOutcome): DecisionGrade {
  const posSize = episode.positionSizeUsd ?? 0;

  // Excellent: realized APY close to or above entry APY AND net positive
  if (outcome.netPnlUsd > 0 && outcome.realizedApyPct >= 0.8 * (episode.positionSizeUsd ? outcome.realizedApyPct : 0)) {
    // More specifically: PnL > gas costs and realized a significant chunk of expected yield
    const expectedYieldUsd = posSize * (outcome.realizedApyPct / 100) * (outcome.daysHeld / 365);
    if (outcome.netPnlUsd >= expectedYieldUsd * 0.7) return 'EXCELLENT';
    return 'GOOD';
  }

  // Good: net positive after costs
  if (outcome.netPnlUsd > GAS_COST_ESTIMATE_USD) return 'GOOD';

  // Neutral: roughly break-even (loss within gas cost range)
  if (outcome.netPnlUsd >= -GAS_COST_ESTIMATE_USD * 2) return 'NEUTRAL';

  // Bad: lost money but less than 2% of position
  if (posSize > 0 && outcome.netPnlUsd >= -(posSize * 0.02)) return 'BAD';

  // Terrible: lost more than 2% of position or very short hold (panic close)
  return 'TERRIBLE';
}

function gradeCloseDecision(_episode: DecisionEpisode, outcome: DecisionOutcome): DecisionGrade {
  // Good close timing: exited before drastic losses or at a reasonable profit
  if (outcome.netPnlUsd >= 0) return 'GOOD';

  // Neutral: small loss on close (could have been worse)
  if (outcome.netPnlUsd >= -GAS_COST_ESTIMATE_USD * 3) return 'NEUTRAL';

  // Bad timing: took a meaningful loss
  return 'BAD';
}

function gradeHoldDecision(outcome: DecisionOutcome): DecisionGrade {
  // Good hold: position continued to earn
  if (outcome.netPnlUsd > 0 && outcome.realizedApyPct > 0) return 'GOOD';

  // Neutral hold: break even
  if (outcome.netPnlUsd >= -GAS_COST_ESTIMATE_USD) return 'NEUTRAL';

  // Bad hold: should have exited
  return 'BAD';
}

function gradeRebalanceDecision(outcome: DecisionOutcome): DecisionGrade {
  // Rebalance is good if the outcome improved PnL
  if (outcome.netPnlUsd > GAS_COST_ESTIMATE_USD) return 'GOOD';
  if (outcome.netPnlUsd >= -GAS_COST_ESTIMATE_USD) return 'NEUTRAL';
  return 'BAD';
}

// ---------------------------------------------------------------------------
// Grade skip decisions (opportunity cost)
// ---------------------------------------------------------------------------

export function gradeSkipDecision(skip: SkipEpisode): DecisionGrade {
  // If we don't have hindsight data yet, can't grade
  if (skip.hindsightApyAfter48h === null) return 'NEUTRAL';

  const apyChange = skip.hindsightApyAfter48h - skip.apyAtSkip;
  const tvlChange = skip.hindsightTvlChangeUsd ?? 0;

  // GOOD skip: pool APY crashed or TVL dropped significantly
  if (apyChange < -(skip.apyAtSkip * 0.3) || tvlChange < -0.2) {
    return 'EXCELLENT'; // We dodged a bullet
  }

  // NEUTRAL skip: APY roughly stable
  if (Math.abs(apyChange) < skip.apyAtSkip * 0.1) return 'NEUTRAL';

  // BAD skip: pool's APY actually increased or held strong
  if (apyChange > skip.apyAtSkip * 0.1) return 'BAD';

  // TERRIBLE skip: APY stayed high and we missed significant yield
  if (skip.hindsightApyAfter48h > skip.apyAtSkip * 1.2) return 'TERRIBLE';

  return 'NEUTRAL';
}

// ---------------------------------------------------------------------------
// Generate lesson learned (deterministic text — no LLM)
// ---------------------------------------------------------------------------

export function generateLesson(episode: DecisionEpisode): string {
  if (!episode.outcome || !episode.grade) return '';

  const { outcome, grade, action, targetProtocol, targetPoolName } = episode;
  const regime = episode.marketRegime ?? 'unknown';
  const pool = targetPoolName ?? targetProtocol ?? 'unknown pool';

  const lines: string[] = [];

  switch (grade) {
    case 'EXCELLENT':
      lines.push(`✅ EXCELLENT ${action} on ${pool} in ${regime} regime.`);
      lines.push(`Held ${outcome.daysHeld.toFixed(0)}d, net PnL: $${outcome.netPnlUsd.toFixed(4)}, realized APY: ${outcome.realizedApyPct.toFixed(2)}%.`);
      lines.push(`Lesson: This type of position works well in ${regime} conditions.`);
      break;
    case 'GOOD':
      lines.push(`👍 GOOD ${action} on ${pool} in ${regime} regime.`);
      lines.push(`Held ${outcome.daysHeld.toFixed(0)}d, net PnL: $${outcome.netPnlUsd.toFixed(4)}.`);
      lines.push(`Lesson: Profitable but could optimize entry/exit timing.`);
      break;
    case 'NEUTRAL':
      lines.push(`➖ NEUTRAL ${action} on ${pool} in ${regime} regime.`);
      lines.push(`Break-even after ${outcome.daysHeld.toFixed(0)}d. Gas costs ate most of the yield.`);
      lines.push(`Lesson: Consider longer hold periods or higher-yield opportunities.`);
      break;
    case 'BAD':
      lines.push(`⚠️ BAD ${action} on ${pool} in ${regime} regime.`);
      lines.push(`Lost $${Math.abs(outcome.netPnlUsd).toFixed(4)} over ${outcome.daysHeld.toFixed(0)}d.`);
      lines.push(`Exit reason: ${outcome.exitReason}. Be cautious with similar setups.`);
      break;
    case 'TERRIBLE':
      lines.push(`🚨 TERRIBLE ${action} on ${pool} in ${regime} regime.`);
      lines.push(`Lost $${Math.abs(outcome.netPnlUsd).toFixed(4)} over ${outcome.daysHeld.toFixed(0)}d.`);
      lines.push(`Exit reason: ${outcome.exitReason}. AVOID similar positions in ${regime} conditions.`);
      break;
  }

  return lines.join(' ');
}

export function generateSkipLesson(skip: SkipEpisode): string {
  if (!skip.grade) return '';

  const pool = `${skip.protocol}/${skip.poolName}`;
  const regime = skip.marketRegime ?? 'unknown';

  switch (skip.grade) {
    case 'EXCELLENT':
      return `✅ GOOD SKIP of ${pool} at ${skip.apyAtSkip.toFixed(1)}% APY in ${regime}. APY dropped to ${skip.hindsightApyAfter48h?.toFixed(1)}% within 48h. Good risk avoidance.`;
    case 'BAD':
    case 'TERRIBLE':
      return `⚠️ MISSED OPPORTUNITY: Skipped ${pool} at ${skip.apyAtSkip.toFixed(1)}% APY in ${regime}. APY held at ${skip.hindsightApyAfter48h?.toFixed(1)}%. Consider being more aggressive in similar setups.`;
    default:
      return `➖ Skip of ${pool} at ${skip.apyAtSkip.toFixed(1)}% in ${regime} was neutral. APY at ${skip.hindsightApyAfter48h?.toFixed(1)}% after 48h.`;
  }
}
