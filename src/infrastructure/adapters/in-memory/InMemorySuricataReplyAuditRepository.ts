import { randomUUID } from 'crypto';
import type { SuricataReplyAuditRepository } from '@domain/ports/SuricataReplyAuditRepository';
import type {
  SuricataReplyAuditRecord,
  RecordSuricataReplyAttemptInput,
  MarkSuricataReplyOutcomeInput,
} from '@domain/entities/suricata';

/**
 * In-memory `SuricataReplyAuditRepository` for use-case tests (Phase E,
 * design D10). `record` always inserts a NEW row with `outcome='failed'`
 * provisionally — there is no "upsert the attempt" path, matching the
 * append-only spirit of `InMemorySuricataVerdictRepository`.
 */
export class InMemorySuricataReplyAuditRepository implements SuricataReplyAuditRepository {
  private rows: SuricataReplyAuditRecord[] = [];

  constructor(private readonly opts: { now?: () => Date } = {}) {}

  async record(input: RecordSuricataReplyAttemptInput): Promise<SuricataReplyAuditRecord> {
    const row: SuricataReplyAuditRecord = {
      id: randomUUID(),
      ticketId: input.ticketId,
      actorId: input.actorId,
      body: input.body,
      outcome: 'failed',
      error: null,
      attemptedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      sentAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async markOutcome(id: string, input: MarkSuricataReplyOutcomeInput): Promise<SuricataReplyAuditRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`SuricataReplyAudit with id ${id} not found`);
    row.outcome = input.outcome;
    row.sentAt = input.sentAt ?? null;
    row.error = input.error ?? null;
    return { ...row };
  }

  /** Test-only helper — read every row for a ticket, oldest first. */
  async listByTicket(ticketId: string): Promise<SuricataReplyAuditRecord[]> {
    return this.rows.filter((r) => r.ticketId === ticketId).map((r) => ({ ...r }));
  }
}
