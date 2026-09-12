/**
 * suricata-tickets-mirror (Phase C, task C.1) — mirror entities for the
 * Suricata Cx ticket sync. Dates are ISO 8601 strings, same convention as
 * `ChatMessageAttachmentRecord`/`ConversationRecord`. `status`/`priority` are
 * kept as RAW strings (design D1.a): an unrecognized value from Suricata must
 * never crash the sync — normalization into filter buckets lives in the DTO
 * layer (Phase F), not here.
 */

export type SuricataMessageAuthorKind = 'customer' | 'agent' | 'system' | 'unknown';
export type SuricataAttachmentStatus = 'pending' | 'stored' | 'failed';
export type SuricataSyncRunOutcome = 'running' | 'ok' | 'degraded' | 'failed';

export interface SuricataAreaRecord {
  id: string;
  externalId: string;
  name: string;
  /** D6.c — an area gone from the upstream catalog flips to false, NEVER deleted. */
  active: boolean;
  syncedAt: string;
}

export interface UpsertSuricataAreaInput {
  externalId: string;
  name: string;
  syncedAt: string;
}

export interface SuricataTicketRecord {
  id: string;
  /** CLAVE DE IDEMPOTENCIA (D6.b) — every persistence is an upsert, never a create. */
  externalId: string;
  subject: string;
  status: string;
  priority: string | null;
  areaId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  externalClientRef: string | null;
  /** Best-effort local match against `Client` — nullable, no physical FK (D13.b). */
  clientId: string | null;
  openedAt: string | null;
  lastMessageAt: string | null;
  /** Internal Prominense assignment — NEVER written back to Suricata. */
  assigneeId: string | null;
  /** sha256 of the ticket's canonical render (D6.b) — see `suricataContentHash.ts`. */
  contentHash: string;
  firstSyncedAt: string;
  syncedAt: string;
}

export interface UpsertSuricataTicketInput {
  externalId: string;
  subject: string;
  status: string;
  priority: string | null;
  /** Already resolved to a local `SuricataArea.id` by the use case — the repo stays dumb. */
  areaId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  externalClientRef: string | null;
  clientId: string | null;
  openedAt: string | null;
  lastMessageAt: string | null;
  contentHash: string;
  syncedAt: string;
}

export interface SuricataMessageRecord {
  id: string;
  ticketId: string;
  /** idempotency key per message. */
  externalId: string;
  author: string;
  authorKind: SuricataMessageAuthorKind;
  body: string;
  sentAt: string;
}

export interface UpsertSuricataMessageInput {
  externalId: string;
  author: string;
  authorKind: SuricataMessageAuthorKind;
  body: string;
  sentAt: string;
}

export interface SuricataAttachmentRecord {
  id: string;
  ticketId: string;
  messageId: string | null;
  /** url/id en Suricata — dedup key together with `ticketId` (`@@unique`). */
  externalRef: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  /** null hasta bajarlo; dedup de CONTENIDO (D7.b) — la key de storage ES el sha256. */
  sha256: string | null;
  /** 'suricata/<sha256>' — null mientras status !== 'stored'. */
  storageKey: string | null;
  status: SuricataAttachmentStatus;
  /** tope 5 (molde `ChatMessageAttachment` MEDIA-3) — pasado el tope, abandono sin loop. */
  attempts: number;
  lastError: string | null;
}

export interface UpsertSuricataAttachmentInput {
  ticketId: string;
  messageId: string | null;
  externalRef: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number | null;
}

export interface MarkSuricataAttachmentStoredInput {
  sha256: string;
  storageKey: string;
  sizeBytes: number;
}

export interface MarkSuricataAttachmentFailedInput {
  error: string;
}

export interface SuricataSyncRunRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: SuricataSyncRunOutcome;
  ticketsSeen: number;
  ticketsUpserted: number;
  messagesUpserted: number;
  attachmentsStored: number;
  error: string | null;
  /** D6.d — required fields missing per ticket (selector likely broken, not silent). */
  selectorMisses: string[] | null;
}

export interface FinishSuricataSyncRunInput {
  outcome: Exclude<SuricataSyncRunOutcome, 'running'>;
  ticketsSeen: number;
  ticketsUpserted: number;
  messagesUpserted: number;
  attachmentsStored: number;
  error?: string | null;
  selectorMisses?: string[] | null;
}

/**
 * suricata-tickets-mirror (Phase D, task D.1, design D9) — append-only bot
 * verdict history. `motivo`/`respuestaSugerida` are nullable at the record
 * level (the schema keeps them optional columns); the CONDITIONAL requirement
 * ("required when resuelto=false") is a business rule enforced by
 * `SubmitSuricataVerdict`, never at this storage layer (spec VERDICT-2).
 */
export interface SuricataVerdictRecord {
  id: string;
  ticketId: string;
  resuelto: boolean;
  analisis: string;
  motivo: string | null;
  respuestaSugerida: string | null;
  /** The ticket's `contentHash` AT THE MOMENT of this verdict (D9) — never updated afterward. */
  ticketContentHash: string;
  /** Login of the machine actor that submitted this verdict (`api-suricata`). */
  submittedBy: string;
  createdAt: string;
}

export interface CreateSuricataVerdictInput {
  ticketId: string;
  resuelto: boolean;
  analisis: string;
  motivo: string | null;
  respuestaSugerida: string | null;
  ticketContentHash: string;
  submittedBy: string;
}

export type SuricataReplyOutcome = 'sent' | 'failed';

/**
 * suricata-tickets-mirror (Phase E, task E.1, design D3/D10) — one row per
 * ATTEMPT, successful or not (REPLY-4). Written with `outcome='failed'`
 * BEFORE the shared session is ever touched, then flipped by `markOutcome`
 * (D10: "auditar el INTENTO, no el éxito").
 */
export interface SuricataReplyAuditRecord {
  id: string;
  ticketId: string;
  /** RbacUser that confirmed the send (soft reference, no physical FK — schema comment). */
  actorId: string;
  /** the EXACT text that was attempted. */
  body: string;
  outcome: SuricataReplyOutcome;
  error: string | null;
  attemptedAt: string;
  sentAt: string | null;
}

export interface RecordSuricataReplyAttemptInput {
  ticketId: string;
  actorId: string;
  body: string;
}

export interface MarkSuricataReplyOutcomeInput {
  outcome: SuricataReplyOutcome;
  sentAt?: string | null;
  error?: string | null;
}
