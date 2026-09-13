/**
 * suricata-bot-autonomous-actions (Phase A, task A.3, design D1.a/D1.b) —
 * discriminated union of the four autonomous write actions the bot can send
 * to Suricata (reply/close/status/note), plus the shared audit
 * record/input shapes `SuricataBotActionAuditRepository` (A.9) works with.
 *
 * D1.a — `payload` is a Prisma `Json` column, NOT four sets of nullable
 * columns: the DB enforces the one invariant that matters (content is
 * always present, `NOT NULL`), and the per-type shape safety lives HERE, in
 * a discriminated union mapped by the repo — same convention this codebase
 * already uses for `SuricataSyncRun.selectorMisses`.
 *
 * D1.b — `outcome` is `'applied' | 'failed'`, ONE vocabulary across all four
 * action types. `'sent'` is reply-specific (see `SuricataReplyAuditRecord`
 * in `suricata.ts`) and would read as a lie on a close or a status change —
 * this table never reuses that vocabulary.
 *
 * `isSuricataBotActionPayload` is the mapper A.4 requires: an unknown or
 * malformed `actionType` is rejected HERE, before it ever reaches the DB —
 * the DB itself only enforces `payload NOT NULL`.
 */

export interface SuricataBotReplyActionPayload {
  actionType: 'reply';
  body: string;
}

export interface SuricataBotCloseActionPayload {
  actionType: 'close';
  reason: string;
}

export interface SuricataBotStatusActionPayload {
  actionType: 'status';
  status: string;
}

export interface SuricataBotNoteActionPayload {
  actionType: 'note';
  text: string;
}

export type SuricataBotActionPayload =
  | SuricataBotReplyActionPayload
  | SuricataBotCloseActionPayload
  | SuricataBotStatusActionPayload
  | SuricataBotNoteActionPayload;

export type SuricataBotActionType = SuricataBotActionPayload['actionType'];

/** 'applied' | 'failed' — ONE vocabulary across all four action types (D1.b). */
export type SuricataBotActionOutcome = 'applied' | 'failed';

export interface SuricataBotActionRecord {
  id: string;
  ticketId: string;
  actionType: SuricataBotActionType;
  /** The exact content that was attempted — one of the four shapes above (D1.a). */
  payload: SuricataBotActionPayload;
  /** `API_SURICATA_USER_LOGIN`, written as a LITERAL — never `anonymous`, never a human session id (D1.c). */
  actorLogin: string;
  outcome: SuricataBotActionOutcome;
  error: string | null;
  attemptedAt: string;
  completedAt: string | null;
}

export interface RecordSuricataBotActionInput {
  ticketId: string;
  actorLogin: string;
  payload: SuricataBotActionPayload;
}

export interface MarkSuricataBotActionOutcomeInput {
  outcome: SuricataBotActionOutcome;
  completedAt?: string | null;
  error?: string | null;
}

/**
 * Rejects any value whose `actionType` isn't one of the four known literals,
 * or whose shape doesn't match that literal's required field — BEFORE it
 * ever reaches the DB (D1.a, task A.4).
 */
export function isSuricataBotActionPayload(value: unknown): value is SuricataBotActionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate['actionType']) {
    case 'reply':
      return typeof candidate['body'] === 'string';
    case 'close':
      return typeof candidate['reason'] === 'string';
    case 'status':
      return typeof candidate['status'] === 'string';
    case 'note':
      return typeof candidate['text'] === 'string';
    default:
      return false;
  }
}
