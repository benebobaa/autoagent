import type { Database } from '../../positions/db.js';

// ---------------------------------------------------------------------------
// Approval store — persists HITL interrupts awaiting Telegram decisions
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface PendingApproval {
  id: string;
  threadId: string;
  checkpointId: string | null;
  interruptValue: unknown;
  telegramMessageId: number | null;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export class ApprovalStore {
  constructor(private readonly db: Database) {}

  async create(params: {
    id: string;
    threadId: string;
    checkpointId: string | null;
    interruptValue: unknown;
  }): Promise<void> {
    await this.db.insertPendingApproval({
      id: params.id,
      threadId: params.threadId,
      checkpointId: params.checkpointId,
      interruptValue: params.interruptValue,
    });
  }

  async setTelegramMessageId(id: string, telegramMessageId: number): Promise<void> {
    await this.db.setApprovalTelegramMessageId(id, telegramMessageId);
  }

  async resolve(id: string, status: 'approved' | 'rejected'): Promise<PendingApproval | null> {
    await this.db.updateApprovalStatus(id, status);
    return this.get(id);
  }

  async get(id: string): Promise<PendingApproval | null> {
    const row = await this.db.getPendingApproval(id);
    if (!row) return null;
    return this.toApproval(row);
  }

  async getByTelegramMessageId(telegramMessageId: number): Promise<PendingApproval | null> {
    const row = await this.db.getPendingApprovalByMessageId(telegramMessageId);
    if (!row) return null;
    return this.toApproval(row);
  }

  private toApproval(row: {
    id: string; threadId: string; checkpointId: string | null;
    interruptValue: unknown; telegramMessageId: number | null; status: string;
    created_at?: string; resolvedAt?: string | null; resolved_at?: string | null;
  }): PendingApproval {
    return {
      id: row.id,
      threadId: row.threadId,
      checkpointId: row.checkpointId,
      interruptValue: row.interruptValue,
      telegramMessageId: row.telegramMessageId,
      status: row.status as ApprovalStatus,
      createdAt: row.created_at ?? new Date().toISOString(),
      resolvedAt: row.resolved_at ?? row.resolvedAt ?? null,
    };
  }
}
