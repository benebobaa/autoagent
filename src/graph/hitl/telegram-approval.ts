import { v4 as uuidv4 } from 'uuid';
import { Command } from '@langchain/langgraph';
import type TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../utils/logger.js';
import { ApprovalStore } from './approval-store.js';
import type { InvestmentTeamGraph } from '../graph.js';
import { getActivePortfolio } from '../../config/portfolio-config.js';
import { formatEntryApprovalRequest } from '../../reporter/format.js';

// ---------------------------------------------------------------------------
// TelegramApprovalBridge
//
// Lifecycle of a HITL interrupt:
//   1. Dispatcher invokes the graph with a thread_id
//   2. Executor tool calls interrupt() → graph pauses, throws GraphInterrupt
//   3. Bridge catches the interrupt payload and calls sendApprovalRequest()
//   4. Telegram sends inline keyboard (Approve / Reject) to the CIO
//   5. CIO taps button → onCallbackQuery() is triggered
//   6. Bridge looks up the approval by Telegram message ID
//   7. Calls graph.invoke(Command({ resume: 'approve'|'reject' }), { configurable: { thread_id }})
//   8. Graph continues from the interrupt point
// ---------------------------------------------------------------------------

export interface ApprovalRequestPayload {
  action: string;
  message: string;
  [key: string]: unknown;
}

function formatExecutionApprovalRequest(payload: ApprovalRequestPayload): string {
  const tier = typeof payload['tier'] === 'number' ? payload['tier'] : null;
  const deploymentMode = typeof payload['deploymentMode'] === 'string' ? payload['deploymentMode'] : 'unknown';
  const positionStyle = typeof payload['positionStyle'] === 'string' ? payload['positionStyle'] : 'unknown';
  const txAction = typeof payload['txAction'] === 'string' ? payload['txAction'] : 'open';
  return [
    'TRANSACTION APPROVAL REQUIRED',
    '',
    `Action: ${txAction}`,
    `Protocol: ${String(payload['protocol'] ?? 'unknown')}`,
    `Pool: ${String(payload['poolName'] ?? 'unknown')}`,
    `Tier: ${tier ?? 'n/a'}`,
    `Mode: ${deploymentMode}`,
    `Style: ${positionStyle}`,
    '',
    String(payload.message ?? ''),
  ].join('\n');
}

export function formatApprovalMessage(payload: ApprovalRequestPayload): string {
  if (payload.action === 'create_position' && typeof payload['tier'] === 'number') {
    try {
      const portfolio = getActivePortfolio();
      const tier = payload['tier'] as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
      const tierConfig = portfolio.getTierConfig(tier);
      return formatEntryApprovalRequest({
        signal: {
          poolAddress: String(payload['opportunityId'] ?? ''),
          tokenSymbol: String(payload['poolName'] ?? payload['protocol'] ?? 'UNKNOWN'),
          confidenceScore: Number(payload['confidenceScore'] ?? 0),
          spikeRatio: payload['spikeRatio'],
        },
        recommendation: 'ENTER',
        score: Number(payload['score'] ?? 0),
        positionSizeUsd: Number(payload['sizeUsd'] ?? 0),
        tier,
        tierConfig,
        reasoning: String(payload['message'] ?? ''),
        concerns: '',
      });
    } catch {
      return String(payload.message ?? 'Approval required');
    }
  }

  if (payload.action === 'execute_transaction') {
    return formatExecutionApprovalRequest(payload);
  }

  return String(payload.message ?? 'Approval required');
}

export class TelegramApprovalBridge {
  private readonly store: ApprovalStore;

  constructor(
    private readonly graph: InvestmentTeamGraph,
    private readonly bot: TelegramBot,
    private readonly chatId: string,
    store: ApprovalStore
  ) {
    this.store = store;

    // Register callback query handler for inline keyboard responses
    this.bot.on('callback_query', (query) => {
      void this.onCallbackQuery(query);
    });
  }

  /**
   * Called when the graph is interrupted.
   * Creates an approval record and sends a Telegram message with inline keyboard.
   */
  async sendApprovalRequest(params: {
    threadId: string;
    checkpointId: string | null;
    payload: ApprovalRequestPayload;
  }): Promise<string> {
    const approvalId = uuidv4();

    // Persist the approval record
    this.store.create({
      id: approvalId,
      threadId: params.threadId,
      checkpointId: params.checkpointId,
      interruptValue: params.payload,
    });

    // Format the Telegram message
    const text = [
      `<b>Action Required</b>`,
      ``,
      formatApprovalMessage(params.payload),
      ``,
      `<i>Approval ID: <code>${approvalId}</code></i>`,
    ].join('\n');

    try {
      const sentMessage = await this.bot.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: `approve:${approvalId}` },
              { text: 'Reject', callback_data: `reject:${approvalId}` },
            ],
          ],
        },
      });

      await this.store.setTelegramMessageId(approvalId, sentMessage.message_id);
      logger.info({ approvalId, threadId: params.threadId }, 'Approval request sent to Telegram');
    } catch (err) {
      logger.error({ err, approvalId }, 'Failed to send approval request to Telegram');
    }

    return approvalId;
  }

  /** Handle Telegram inline keyboard callback */
  private async onCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    const data = query.data;
    if (!data) return;

    const [action, approvalId] = data.split(':');
    if (!approvalId || (action !== 'approve' && action !== 'reject')) return;

    const approval = await this.store.get(approvalId);
    if (!approval || approval.status !== 'pending') {
      logger.warn({ approvalId }, 'Received callback for unknown or already-resolved approval');
      await this.bot.answerCallbackQuery(query.id, { text: 'This action has already been resolved.' });
      return;
    }

    const decision = action === 'approve' ? 'approved' : 'rejected';
    await this.store.resolve(approvalId, decision);

    logger.info({ approvalId, threadId: approval.threadId, decision }, 'HITL decision received');

    // Acknowledge the Telegram button tap
    await this.bot.answerCallbackQuery(query.id, {
      text: decision === 'approved' ? 'Approved!' : 'Rejected.',
    });

    // Edit the message to show the decision
    try {
      await this.bot.editMessageText(
        `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${formatApprovalMessage(approval.interruptValue as ApprovalRequestPayload)}`,
        {
          chat_id: this.chatId,
          message_id: approval.telegramMessageId ?? undefined,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        }
      );
    } catch {
      // Non-critical — message might have been deleted
    }

    // Resume the graph with the decision
    try {
      await this.graph.invoke(
        new Command({ resume: decision }),
        { configurable: { thread_id: approval.threadId } }
      );
      logger.info({ threadId: approval.threadId, decision }, 'Graph resumed after HITL decision');
    } catch (err) {
      logger.error({ err, threadId: approval.threadId }, 'Failed to resume graph after HITL decision');
    }
  }
}
