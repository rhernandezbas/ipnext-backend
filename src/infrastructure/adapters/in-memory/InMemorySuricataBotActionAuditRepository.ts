import { randomUUID } from 'crypto';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';
import type {
  SuricataBotActionRecord,
  RecordSuricataBotActionInput,
  MarkSuricataBotActionOutcomeInput,
} from '@domain/entities/suricataBotAction';

/**
 * In-memory `SuricataBotActionAuditRepository` for use-case tests (Phase A,
 * task A.11, design D1/D3/D10). `record` always inserts a NEW row with
 * `outcome:'failed'` provisionally — there is no "upsert the attempt" path,
 * matching the append-only spirit of `InMemorySuricataReplyAuditRepository`.
 */
export class InMemorySuricataBotActionAuditRepository implements SuricataBotActionAuditRepository {
  private rows: SuricataBotActionRecord[] = [];

  constructor(private readonly opts: { now?: () => Date } = {}) {}

  async record(input: RecordSuricataBotActionInput): Promise<SuricataBotActionRecord> {
    const row: SuricataBotActionRecord = {
      id: randomUUID(),
      ticketId: input.ticketId,
      actionType: input.payload.actionType,
      payload: input.payload,
      actorLogin: input.actorLogin,
      outcome: 'failed',
      error: null,
      attemptedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      completedAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async markOutcome(id: string, input: MarkSuricataBotActionOutcomeInput): Promise<SuricataBotActionRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`SuricataBotActionAudit with id ${id} not found`);
    row.outcome = input.outcome;
    row.completedAt = input.completedAt ?? null;
    row.error = input.error ?? null;
    return { ...row };
  }

  async listByTicket(ticketId: string): Promise<SuricataBotActionRecord[]> {
    return this.rows.filter((r) => r.ticketId === ticketId).map((r) => ({ ...r }));
  }
}
