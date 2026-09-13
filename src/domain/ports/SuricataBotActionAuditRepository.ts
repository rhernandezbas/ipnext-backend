import type {
  SuricataBotActionRecord,
  RecordSuricataBotActionInput,
  MarkSuricataBotActionOutcomeInput,
} from '@domain/entities/suricataBotAction';

/**
 * suricata-bot-autonomous-actions (Phase A, task A.9, design D1/D3) — ONE
 * unified, append-only audit port covering all four autonomous write
 * actions (reply/close/status/note) as a single action-type-discriminated
 * record set (EXTAUDIT-7 — queryable as one set, no per-type union).
 *
 * `record` is called BEFORE the shared session is ever touched, auditing
 * the ATTEMPT and not the outcome (EXTAUDIT-3): the row starts
 * `outcome:'failed'` provisionally. `markOutcome` later flips it to
 * `'applied'` (with `completedAt`) or leaves it `'failed'` with the concrete
 * `error` once the actual driver call resolves — molde
 * `SuricataReplyAuditRepository`, generalized to 4 action types.
 */
export interface SuricataBotActionAuditRepository {
  record(input: RecordSuricataBotActionInput): Promise<SuricataBotActionRecord>;
  markOutcome(id: string, input: MarkSuricataBotActionOutcomeInput): Promise<SuricataBotActionRecord>;
  /** EXTAUDIT-7 — every action recorded for a ticket, mixed action types in one call, oldest first. */
  listByTicket(ticketId: string): Promise<SuricataBotActionRecord[]>;
}
