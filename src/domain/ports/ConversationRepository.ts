import { PaginatedQuery, PaginatedResult } from '../../application/dto/pagination';

/**
 * messaging-inbox (F1) — mirror row of `Conversation` (design §1). Dates are
 * ISO 8601 strings, never raw Prisma `Date` objects (same convention as
 * `OwnershipTransferCase`/`ContractListItem`).
 */
export interface ConversationRecord {
  id: string;
  chatwootConversationId: number;
  contactName: string | null;
  contactPhone: string | null;
  status: string;
  /** Cache of Chatwoot's `can_reply` — read by SendMessage, never recomputed locally (design §4). */
  canReply: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Upsert keyed by `chatwootConversationId` (unique). Undefined optional fields
 * are left UNTOUCHED on update; on create they fall back to schema defaults
 * (`status='open'`, `canReply=false`). One method serves all 3 HOOK-4 event
 * handlers plus the INBOX-2 fetch-on-open refresh — each caller only passes
 * the fields it actually knows about.
 */
export interface UpsertConversationInput {
  chatwootConversationId: number;
  contactName?: string | null;
  contactPhone?: string | null;
  status?: string;
  canReply?: boolean;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

export interface ConversationRepository {
  findById(id: string): Promise<ConversationRecord | null>;
  findByChatwootId(chatwootConversationId: number): Promise<ConversationRecord | null>;
  upsertByChatwootId(input: UpsertConversationInput): Promise<ConversationRecord>;
  /** INBOX-1 — paginated listing, ordered by `lastMessageAt` DESC (nulls last, never-messaged conversations sort to the bottom). */
  list(query: PaginatedQuery): Promise<PaginatedResult<ConversationRecord>>;
}
