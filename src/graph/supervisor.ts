import { Command } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentStateType } from './state.js';
import type { Signal } from '../signals/types.js';
import type { Database } from '../positions/db.js';
import type { RAGStore } from '../rag/store.js';
import type { CapitalIntent } from '../portfolio/intents.js';
import { buildExperienceBrief } from '../rag/experience-injector.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Supervisor routing schema (structured output)
// ---------------------------------------------------------------------------

type NextAgent = 'analyst' | 'risk' | 'trader' | 'reporter' | '__end__';

interface SupervisorDecision {
  reasoning: string;
  next: NextAgent;
  instructions: string;
}

// ---------------------------------------------------------------------------
// Supervisor system prompt
// ---------------------------------------------------------------------------

const SUPERVISOR_SYSTEM = `You are the CIO (Chief Investment Officer) of an autonomous Solana DeFi yield optimization team.
Your team consists of four specialists:
- analyst: Scans markets, fetches pool data, identifies yield opportunities
- risk: Scores opportunities, computes portfolio PnL, detects signals, assesses market regime
- trader: Opens/closes positions, builds and simulates transactions (requires human approval)
- reporter: Formats and sends Telegram reports and alerts

Your job is to orchestrate them based on the current signals and state.

Routing rules:
- CRITICAL signals → risk first, then trader (only if risk recommends action), then reporter
- HIGH signals → analyst first, then risk, then trader (if risk recommends), then reporter
- LOW signals or HEARTBEAT → analyst, then risk, then trader (if open position slots AND risk recommends), then reporter
- VOLUME_SPIKE and MEME_POOL_DISCOVERED are tier-aware active DLMM opportunities: ensure analyst and risk both consider the recommended tier before trader acts
- POSITION_AUTO_EXIT and CIRCUIT_BREAKER_TRIGGERED are capital protection events: prioritize risk, then trader for deterministic close actions, then reporter
- PORTFOLIO_REBALANCE should usually go to risk first, then reporter unless a deterministic action set exists
- ALWAYS route through risk after analyst — risk decides whether to trade or hold
- If active positions < max_open_positions AND analyst finds SUGGEST-rated opportunities, risk should recommend the trader deploy capital
- After any agent completes, re-evaluate: proceed to the next logical agent or end
- Once reporter has sent the relevant report/alert, go to __end__
- Do NOT loop back to already-completed agents in the same run (check message history)
- Prioritize capital protection over yield maximization, but do not leave capital idle when safe opportunities exist

Respond with a JSON object with exactly these fields:
{
  "reasoning": "Brief explanation of why you are routing to this agent",
  "next": "analyst" | "risk" | "trader" | "reporter" | "__end__",
  "instructions": "Specific instructions for the next agent (or empty string if __end__)"
}`;

// ---------------------------------------------------------------------------
// Signal summary helper
// ---------------------------------------------------------------------------

function summarizeSignals(signals: Signal[]): string {
  if (signals.length === 0) return 'No signals (HEARTBEAT run)';
  const byPriority: Record<string, string[]> = { CRITICAL: [], HIGH: [], LOW: [] };
  for (const s of signals) {
    const payload = s.payload as Record<string, unknown>;
    const summaryBits = [
      payload['recommendedTier'] !== undefined ? `tier=${String(payload['recommendedTier'])}` : null,
      payload['exitReason'] !== undefined ? `exit=${String(payload['exitReason'])}` : null,
      payload['rebalanceReason'] !== undefined ? `rebalance=${String(payload['rebalanceReason'])}` : null,
      payload['confidenceScore'] !== undefined ? `confidence=${String(payload['confidenceScore'])}` : null,
    ].filter((item): item is string => item !== null);
    (byPriority[s.priority] ?? []).push(`${s.type}${summaryBits.length > 0 ? `[${summaryBits.join(',')}]` : ''}(${JSON.stringify(s.payload).slice(0, 80)})`);
  }
  return Object.entries(byPriority)
    .filter(([, items]) => items.length > 0)
    .map(([p, items]) => `${p}: ${items.join(', ')}`)
    .join(' | ');
}

function summarizeCapitalIntents(intents: CapitalIntent[]): string {
  if (intents.length === 0) return 'none';

  return intents.map((intent) => {
    if (intent.action === 'close') {
      return `close ${intent.protocol}/${intent.poolName} (${intent.closeReason ?? intent.reason})`;
    }

    if (intent.action === 'claim_fee') {
      return `claim fees ${intent.protocol}/${intent.poolName}`;
    }

    return `open ${intent.book} ${intent.protocol}/${intent.poolName} for $${intent.sizeUsd ?? 0}`;
  }).join(', ');
}

// ---------------------------------------------------------------------------
// createSupervisorNode — returns a LangGraph node function
// ---------------------------------------------------------------------------

export function createSupervisorNode(llm: BaseChatModel, db: Database, ragStore: RAGStore, maxOpenPositions = 6) {
  // Use plain LLM invocation — do NOT use withStructuredOutput/tool_choice.
  // deepseek-reasoner (and some other models) reject tool_choice with HTTP 400.
  // The system prompt already instructs the model to return a JSON object,
  // and the response is parsed from text below.
  const routerLlm = llm;

  return async (state: AgentStateType): Promise<Command> => {
    const signalTypes = new Set(state.currentSignals.map((signal) => signal.type));
    const hasTieredDiscoverySignal = signalTypes.has('VOLUME_SPIKE') || signalTypes.has('MEME_POOL_DISCOVERED');
    const hasAutoExitSignal = signalTypes.has('POSITION_AUTO_EXIT');
    const hasCircuitBreakerSignal = signalTypes.has('CIRCUIT_BREAKER_TRIGGERED');
    const hasRebalanceSignal = signalTypes.has('PORTFOLIO_REBALANCE');

    // Deterministic end: once reporter has run, always end the run — no LLM needed.
    // This prevents the supervisor LLM from routing analyst→risk→trader→reporter→analyst loops.
    if (state.lastActiveAgent === 'reporter' && state.capitalIntents.length === 0) {
      return new Command({
        update: {
          supervisorReasoning: 'Reporter completed — ending run',
          lastActiveAgent: '__end__',
        },
        goto: '__end__',
      });
    }

    // HEARTBEAT fast-path: HEARTBEAT-only signals skip analysis and go straight to reporter.
    // HEARTBEAT is a daily status trigger, not an opportunity signal — running the full
    // analyst→risk→trader pipeline wastes tokens and hits the recursion limit.
    const isHeartbeatOnly =
      state.currentSignals.length > 0 &&
      state.currentSignals.every((s) => s.type === 'HEARTBEAT');
    if (isHeartbeatOnly && state.capitalIntents.length === 0 && state.lastActiveAgent === null) {
      return new Command({
        update: {
          supervisorReasoning: 'HEARTBEAT-only run — going directly to reporter for daily status',
          lastActiveAgent: 'reporter',
          messages: [{
            role: 'user' as const,
            content: `[Supervisor → reporter] Daily heartbeat. Send a tier-aware portfolio status update using send_tier_portfolio_report when possible; otherwise use send_daily_report. Do not escalate or ask for human input.`,
          }],
        },
        goto: 'reporter',
      });
    }

    if ((hasAutoExitSignal || hasCircuitBreakerSignal) && state.capitalIntents.length === 0) {
      if (state.lastActiveAgent === null) {
        return new Command({
          update: {
            supervisorReasoning: 'Capital protection signal detected — route to risk for immediate assessment before execution.',
            lastActiveAgent: 'risk',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → risk] Assess the auto-exit or circuit-breaker signal immediately. Prioritize capital protection, identify deterministic closes, and keep the recommendation concise.',
            }],
          },
          goto: 'risk',
        });
      }

      if (state.lastActiveAgent === 'risk') {
        return new Command({
          update: {
            supervisorReasoning: 'Risk review complete for capital protection signal — route to trader for deterministic close or circuit-breaker handling.',
            lastActiveAgent: 'trader',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → trader] Execute the deterministic close or protection actions implied by the current auto-exit or circuit-breaker signal. Prefer prompt simulated exits over new entries.',
            }],
          },
          goto: 'trader',
        });
      }

      if (state.lastActiveAgent === 'trader') {
        return new Command({
          update: {
            supervisorReasoning: 'Trader handled the capital protection path — route to reporter.',
            lastActiveAgent: 'reporter',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → reporter] Send a concise exit or circuit-breaker update, including affected tiers and whether positions were closed or queued for action.',
            }],
          },
          goto: 'reporter',
        });
      }
    }

    if (hasTieredDiscoverySignal && state.capitalIntents.length === 0) {
      if (state.lastActiveAgent === null) {
        return new Command({
          update: {
            supervisorReasoning: 'Tier-aware active DLMM opportunity detected — send to analyst first for tier-specific market context.',
            lastActiveAgent: 'analyst',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → analyst] Evaluate the active-DLMM opportunity against its recommended tier, including confidence, momentum, liquidity, and whether it fits a tier-limited allocation.',
            }],
          },
          goto: 'analyst',
        });
      }

      if (state.lastActiveAgent === 'analyst') {
        return new Command({
          update: {
            supervisorReasoning: 'Analyst reviewed the tier-aware active DLMM opportunity — send to risk for entry sizing and constraints.',
            lastActiveAgent: 'risk',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → risk] Score this opportunity for its recommended tier, respect tier capital limits, and decide whether the trader should enter, watch, or skip.',
            }],
          },
          goto: 'risk',
        });
      }

      if (state.lastActiveAgent === 'risk') {
        return new Command({
          update: {
            supervisorReasoning: 'Risk completed tier-aware entry review — route to trader for execution if appropriate.',
            lastActiveAgent: 'trader',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → trader] If risk endorsed the trade, create the position using the supplied tier, deployment mode, and position style. Respect HITL for tier 8/9 entries even in paper mode.',
            }],
          },
          goto: 'trader',
        });
      }

      if (state.lastActiveAgent === 'trader') {
        return new Command({
          update: {
            supervisorReasoning: 'Trader completed the tier-aware entry path — route to reporter.',
            lastActiveAgent: 'reporter',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → reporter] Summarize the active-DLMM opportunity review, any approval gate involved, and whether a new tiered position was opened or skipped.',
            }],
          },
          goto: 'reporter',
        });
      }
    }

    if (hasRebalanceSignal && state.capitalIntents.length === 0) {
      if (state.lastActiveAgent === null) {
        return new Command({
          update: {
            supervisorReasoning: 'Portfolio rebalance signal detected — route to risk first.',
            lastActiveAgent: 'risk',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → risk] Evaluate the rebalance signal, compare current vs target tier allocations, and determine whether any deterministic action is required now.',
            }],
          },
          goto: 'risk',
        });
      }

      if (state.lastActiveAgent === 'risk') {
        return new Command({
          update: {
            supervisorReasoning: 'Risk reviewed the rebalance signal — route to reporter unless deterministic actions are already queued.',
            lastActiveAgent: 'reporter',
            messages: [{
              role: 'user' as const,
              content: '[Supervisor → reporter] Send a tier-aware rebalance summary, including current vs target allocations and whether the system is only monitoring or actively shifting exposure.',
            }],
          },
          goto: 'reporter',
        });
      }
    }

    // Fast path: if positions are at capacity AND signals are all LOW/HEARTBEAT
    // → skip analyst/risk/trader and go straight to a brief reporter update.
    // This avoids burning tokens on analysis when there's nothing actionable to do.
    const hasOnlySoftSignals = state.currentSignals.every((s) => s.priority === 'LOW');
    const atCapacity = state.activePositions.length >= maxOpenPositions;
    if (
      atCapacity &&
      hasOnlySoftSignals &&
      state.capitalIntents.length === 0 &&
      state.lastActiveAgent === null
    ) {
      return new Command({
        update: {
          supervisorReasoning: `All ${state.activePositions.length}/${maxOpenPositions} position slots filled, only LOW signals — sending brief status update`,
          lastActiveAgent: 'reporter',
          messages: [{
            role: 'user' as const,
            content: `[Supervisor → reporter] All ${state.activePositions.length} position slots are full. Send a brief portfolio status update (use send_daily_report). Do not escalate or ask for human input.`,
          }],
        },
        goto: 'reporter',
      });
    }

    if (state.capitalIntents.length > 0) {
      const intentSummary = summarizeCapitalIntents(state.capitalIntents);

      if (state.lastActiveAgent === 'trader') {
        return new Command({
          update: {
            supervisorReasoning: `Deterministic capital intents were executed or queued: ${intentSummary}`,
            lastActiveAgent: 'reporter',
            messages: [{ role: 'user' as const, content: `[Supervisor → reporter] Report the deterministic capital actions: ${intentSummary}.` }],
          },
          goto: 'reporter',
        });
      }

      if (state.lastActiveAgent === 'reporter') {
        return new Command({
          update: {
            supervisorReasoning: `Deterministic capital intents completed: ${intentSummary}`,
            lastActiveAgent: '__end__',
          },
          goto: '__end__',
        });
      }

      return new Command({
        update: {
          supervisorReasoning: `Executing deterministic capital intents: ${intentSummary}`,
          lastActiveAgent: 'trader',
          messages: [{ role: 'user' as const, content: `[Supervisor → trader] Execute only these deterministic capital intents: ${intentSummary}. Do not choose pools or sizes yourself.` }],
        },
        goto: 'trader',
      });
    }

    const signalSummary = summarizeSignals(state.currentSignals);
    const hasCritical = state.currentSignals.some((s) => s.priority === 'CRITICAL');
    const hasHigh = state.currentSignals.some((s) => s.priority === 'HIGH');

    // Get market regime from state or signal payload
    const regime = state.currentRegime ??
      (state.currentSignals.find(s => s.type === 'REGIME_SHIFT')?.payload as any)?.newRegime ?? null;

    // Fetch past experience related to these signals and regime
    const experience = await buildExperienceBrief(db, ragStore, {
      signalTypes: state.currentSignals.map(s => s.type),
      regime,
      // If there's an opportunity context, we could extract protocol here, but supervisor works higher level
    });

    if (experience.hasInsights) {
      logger.debug({ lessonCount: experience.lessonCount }, 'Injected experience brief into supervisor');
    }

    // Build context message for the supervisor
    const context = [
      `Current signals: ${signalSummary}`,
      `Active positions: ${state.activePositions.length}`,
      `Deterministic capital intents: ${summarizeCapitalIntents(state.capitalIntents)}`,
      `Last active agent: ${state.lastActiveAgent ?? 'none'}`,
      `Messages in thread so far: ${state.messages.length}`,
      `Current Regime: ${regime ?? 'unknown'}`,
    ].join('\n');

    // Filter out tool-role messages — DeepSeek rejects tool results that appear without
    // their originating tool_call in the same request (common when passing agent history).
    // Also drop AIMessages that have tool_calls to avoid orphaned call/result pairs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const safeHistory = (state.messages as any[])
      .filter((m) => {
        const role = m?.role ?? m?._getType?.();
        if (role === 'tool') return false;
        if ((role === 'assistant' || role === 'ai') && m?.tool_calls?.length > 0) return false;
        return true;
      })
      .slice(-6);

    const messages = [
      { role: 'system' as const, content: `${SUPERVISOR_SYSTEM}\n\n${experience.text}`.trim() },
      ...safeHistory,
      {
        role: 'user' as const,
        content: `Current state:\n${context}\n\nDecide which agent to activate next, or end the run.`,
      },
    ];

    let decision: SupervisorDecision;

    try {
      const response = await routerLlm.invoke(messages);
      // Plain LLM returns a BaseMessage — extract text content and parse JSON.
      // The system prompt instructs the model to return a JSON object.
      // DeepSeek wraps JSON in markdown code fences; the regex handles both cases.
      const content = typeof response === 'string' ? response : (response as { content: string }).content;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? (jsonMatch[1] ?? content) : content;
      decision = JSON.parse(jsonStr.trim()) as SupervisorDecision;
    } catch (err) {
      logger.warn({ err }, 'Supervisor LLM routing failed — using priority-based fallback');
      // Fallback routing when LLM fails: always run the full pipeline
      // analyst → risk → trader → reporter regardless of signal priority,
      // so a transient LLM error never silently skips investment analysis.
      const next: NextAgent =
        state.lastActiveAgent === null
          ? 'analyst'
          : state.lastActiveAgent === 'analyst'
            ? 'risk'
            : state.lastActiveAgent === 'risk'
              ? 'trader'
              : state.lastActiveAgent === 'trader'
                ? 'reporter'
                : '__end__';

      const fallbackInstructions: Record<string, string> = {
        analyst: 'Scan markets and identify the top yield opportunities.',
        risk: 'Assess the current signals and portfolio risk. Score the top opportunities and recommend whether to act.',
        trader: 'Execute only the deterministic capital intents supplied by the supervisor. Do not choose pools or sizes yourself.',
        reporter: 'Send a Telegram report summarising the current portfolio status and any actions taken or recommended.',
      };

      decision = {
        reasoning: 'LLM routing failed — using priority-based fallback',
        next,
        instructions: fallbackInstructions[next] ?? '',
      };
    }

    const { reasoning, next, instructions } = decision;

    if (next === '__end__') {
      return new Command({
        update: { supervisorReasoning: reasoning, lastActiveAgent: '__end__' },
        goto: '__end__',
      });
    }

    return new Command({
      update: {
        supervisorReasoning: reasoning,
        lastActiveAgent: next,
        messages: [
          {
            role: 'user' as const,
            content: instructions
              ? `[Supervisor → ${next}] ${instructions}`
              : `[Supervisor → ${next}] Please proceed with your analysis.`,
          },
        ],
      },
      goto: next,
    });
  };
}
