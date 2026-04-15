import type { Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import type { AgentConfig } from '../config/loader.js';
import type { Database } from '../positions/db.js';
import type { TelegramReporter } from '../reporter/telegram.js';
import { logger } from '../utils/logger.js';
import { startSignalLoop, type SignalLoopHandles } from './loop.js';
import type { DispatchHandler } from './dispatcher.js';

type KitRpc = ReturnType<typeof createSolanaRpc>;

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RESTART_DELAY_MS = 30 * 1000; // 30 seconds

export class SignalLoopSupervisor {
  private handles: SignalLoopHandles | null = null;
  private restartCount = 0;
  private firstRestartTime: number | null = null;
  private stopped = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: Database,
    private readonly connection: Connection,
    private readonly kitRpc: KitRpc,
    private readonly reporter: TelegramReporter,
    private readonly dispatchHandler?: DispatchHandler
  ) {}

  public async start(): Promise<void> {
    if (this.stopped) return;

    try {
      this.handles = startSignalLoop(
        this.config,
        this.db,
        this.connection,
        this.kitRpc,
        this.reporter,
        this.dispatchHandler
      );
      logger.info('Supervisor successfully started signal loop.');
    } catch (err) {
      this.handleCrash(err);
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.handles) {
      this.handles.stop();
      this.handles = null;
    }
    logger.info('Supervisor stopped.');
  }

  public get lastTickTime(): number {
    return this.handles?.poller.lastTickTime ?? 0;
  }

  public get tickCount(): number {
    return this.handles?.poller.tickCount ?? 0;
  }

  public getHandles(): SignalLoopHandles | null {
    return this.handles;
  }

  public handleCrash(err: unknown) {
    if (this.stopped) return;

    logger.error({ err }, 'Signal loop crashed unexpectedly.');
    
    if (this.handles) {
      try {
        this.handles.stop();
      } catch (e) {
        logger.error({ err: e }, 'Error stopping old loop on crash');
      }
      this.handles = null;
    }

    const now = Date.now();
    if (this.firstRestartTime && now - this.firstRestartTime > RESTART_WINDOW_MS) {
      // Reset window
      this.restartCount = 0;
      this.firstRestartTime = now;
    } else if (!this.firstRestartTime) {
      this.firstRestartTime = now;
    }

    this.restartCount++;

    if (this.restartCount > MAX_RESTARTS) {
      const msg = `CRITICAL: Signal loop crashed ${this.restartCount} times within 10 minutes. Supervisor giving up and exiting.`;
      logger.fatal(msg);
      void this.reporter.sendMessage(`🚨 <b>${msg}</b>`);
      
      // Give time for Telegram to send, then exit
      setTimeout(() => process.exit(1), 2000);
      return;
    }

    const msg = `⚠️ Signal loop crashed, restarting in ${RESTART_DELAY_MS / 1000}s (restart ${this.restartCount}/${MAX_RESTARTS})`;
    logger.warn(msg);
    void this.reporter.sendMessage(msg);

    setTimeout(() => {
      logger.info('Supervisor restarting signal loop...');
      void this.start();
    }, RESTART_DELAY_MS);
  }
}

let _supervisorInstance: SignalLoopSupervisor | null = null;

export function startSupervisedSignalLoop(
  config: AgentConfig,
  db: Database,
  connection: Connection,
  kitRpc: KitRpc,
  reporter: TelegramReporter,
  dispatchHandler?: DispatchHandler
): SignalLoopSupervisor {
  if (_supervisorInstance) {
    return _supervisorInstance;
  }

  const supervisor = new SignalLoopSupervisor(
    config,
    db,
    connection,
    kitRpc,
    reporter,
    dispatchHandler
  );
  _supervisorInstance = supervisor;

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught Exception bypassed standard error handling');
    if (_supervisorInstance) {
      _supervisorInstance.handleCrash(err);
    } else {
      process.exit(1);
    }
  });

  void supervisor.start();
  return supervisor;
}
