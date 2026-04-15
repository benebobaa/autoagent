import TelegramBot from 'node-telegram-bot-api';
import type { AgentConfig } from '../config/loader.js';
import {
  type ReportData,
  formatDailyReport,
  formatEntryApprovalRequest,
  formatExitNotification,
  formatRebalanceNotification,
  formatTierPortfolioReport,
  type TierMonitorSummary,
} from './format.js';
import { logger } from '../utils/logger.js';
import type { Signal } from '../signals/types.js';
import type { PortfolioConfig } from '../config/portfolio-config.js';

const MAX_MESSAGE_LENGTH = 4096;

// Telegram HTML mode only supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <tg-spoiler>, <tg-emoji>
// Strategy: replace <br>, strip common HTML tags, then replace ALL remaining angle-bracket
// sequences that aren't valid Telegram tags (e.g. LLM math "<0.01%", "<$100") with escaped versions.
const VALID_TELEGRAM_TAG_RE = /^<\/?(b|i|u|s|code|pre|a(\s[^>]*)?)>$|^<tg-(spoiler|emoji)[^>]*>$|^<\/tg-(spoiler|emoji)>$/i;

function sanitizeTelegramHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|span|hr|h[1-6]|ul|ol|li|table|tr|td|th|thead|tbody|img|em|strong|del|ins|mark)[^>]*>/gi, '')
    // Replace any remaining <...> sequence that isn't a valid Telegram HTML tag
    .replace(/<[^>]*>/g, (match) =>
      VALID_TELEGRAM_TAG_RE.test(match) ? match : match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    )
    // Also escape bare < not followed by a letter (math operators like "< 0.01%", "< $100")
    .replace(/<(?![/a-zA-Z])/g, '&lt;');
}

export class TelegramReporter {
  private bot: TelegramBot | null = null;

  constructor(
    private readonly config: AgentConfig,
    /** Pass true when using the bot for HITL — enables polling for callback queries */
    private readonly enablePolling = false
  ) {
    if (config.telegramBotToken) {
      this.bot = new TelegramBot(config.telegramBotToken, {
        polling: enablePolling
          ? { interval: 2000, params: { timeout: 30 } }
          : false,
      });

      this.bot.on('polling_error', (err) => {
        logger.error({ err: err.message }, 'Telegram polling error — will retry');
      });
    }
  }

  /** Expose the underlying bot for the HITL approval bridge */
  getBot(): TelegramBot | null {
    return this.bot;
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.config.telegramChatId) {
      // Fallback: print to stdout
      logger.info('[Telegram not configured] Report output:');
      console.log(text);
      return;
    }

    try {
      const sanitized = sanitizeTelegramHtml(text);
      const message =
        sanitized.length > MAX_MESSAGE_LENGTH
          ? sanitized.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n...(truncated)'
          : sanitized;

      await this.bot.sendMessage(this.config.telegramChatId, message, {
        parse_mode: 'HTML',
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — type mismatch in older @types/node-telegram-bot-api
        disable_web_page_preview: true,
      });

      logger.info('Telegram report sent');
    } catch (err) {
      logger.error({ err }, 'Failed to send Telegram message — falling back to stdout');
      console.log(text);
    }
  }

  async sendDailyReport(data: ReportData): Promise<void> {
    const text = formatDailyReport(data);
    await this.sendMessage(text);
  }

  async sendTierPortfolioReport(
    positionMonitorSummary: TierMonitorSummary,
    portfolioConfig: PortfolioConfig,
    dailyPnlByTier: Record<number, number>,
    totalCapital: number,
    paperTrading: boolean,
  ): Promise<void> {
    const text = formatTierPortfolioReport(positionMonitorSummary, portfolioConfig, dailyPnlByTier, totalCapital, paperTrading);
    await this.sendMessage(text);
  }

  async sendEntryApprovalRequest(params: Parameters<typeof formatEntryApprovalRequest>[0]): Promise<void> {
    await this.sendMessage(formatEntryApprovalRequest(params));
  }

  async sendExitNotification(exitResult: Record<string, unknown>, tier: number): Promise<void> {
    await this.sendMessage(formatExitNotification(exitResult, tier));
  }

  async sendRebalanceNotification(params: Parameters<typeof formatRebalanceNotification>[0]): Promise<void> {
    await this.sendMessage(formatRebalanceNotification(params));
  }

  /** Send an immediate alert for a CRITICAL or HIGH signal before LangGraph handles it. */
  async sendSignalAlert(signal: Signal): Promise<void> {
    const priorityEmoji = signal.priority === 'CRITICAL' ? '🚨' : '⚠️';
    const payloadSummary = Object.entries(signal.payload)
      .slice(0, 4)
      .map(([k, v]) => `  ${k}: ${String(v)}`)
      .join('\n');

    const text = [
      `${priorityEmoji} <b>[${signal.priority}] ${signal.type}</b>`,
      '',
      payloadSummary,
      '',
      `<i>${new Date(signal.timestamp).toUTCString()}</i>`,
    ].join('\n');

    await this.sendMessage(text);
  }
}
