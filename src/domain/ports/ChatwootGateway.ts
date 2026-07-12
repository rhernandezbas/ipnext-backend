/**
 * messaging-inbox (F1) — port for the Chatwoot Application API (design §3).
 * Adapter: `infrastructure/adapters/chatwoot/HttpChatwootGateway.ts` (B3).
 * Types here are DOMAIN shapes (already mapped from Chatwoot's wire format) —
 * use cases NEVER see raw Chatwoot JSON.
 */

export interface ChatwootConversationDto {
  id: number;
  /**
   * H3 — `undefined` means the field was ABSENT from Chatwoot's response (the
   * adapter must NOT coerce that to `null`): callers forward it straight into
   * `UpsertConversationInput`, where `undefined` = leave untouched and `null` =
   * a real known value to write. Coercing absence to `null` here would let a
   * partial GET response wipe out a good value already in the mirror.
   */
  contactName?: string | null;
  contactPhone?: string | null;
  /**
   * Residuo #3 — same H3 rule as `contactName`/`contactPhone`: `undefined` means
   * ABSENT from Chatwoot's response, forwarded straight into `UpsertConversationInput`
   * where `undefined` = leave untouched. Defaulting absence to `'open'` here (the old
   * behavior) let a partial GET response CLOBBER a real status already in the mirror
   * during fetch-on-open — exactly the asymmetry the webhook path already avoided.
   */
  status?: string;
  /**
   * Cache of Chatwoot's `can_reply` — SendMessage reads this from the mirror, never
   * recomputed locally. Residuo #3 — `undefined` (field absent), NOT a defaulted
   * `false`, for the same clobber-avoidance reason as `status` above.
   */
  canReply?: boolean;
  lastActivityAt?: string | null;
}

export interface ChatwootMessageDto {
  id: number;
  /** null = filtered by design §7 (activity/template message_type — not persisted). */
  direction: 'inbound' | 'outbound' | null;
  content: string;
  senderName: string | null;
  createdAt: string;
  /**
   * H2 residual — true for an internal agent note (Chatwoot's `private` flag), same
   * meaning as `ChatwootWebhookPayload.private` in `ReceiveChatwootWebhook`. The GET
   * path (`HttpChatwootGateway.listMessages`, consumed by `GetConversation`'s
   * fetch-on-open) has no other channel to signal this — `direction` alone isn't
   * enough (a private note is still message_type "outgoing"/1 → 'outbound'). Callers
   * MUST treat `private === true` the same as `direction === null`: never persisted,
   * never bumps the preview.
   */
  private?: boolean;
}

export interface ChatwootGateway {
  listConversations(): Promise<ChatwootConversationDto[]>;
  getConversation(chatwootConversationId: number): Promise<ChatwootConversationDto>;
  listMessages(chatwootConversationId: number): Promise<ChatwootMessageDto[]>;
  sendMessage(chatwootConversationId: number, content: string): Promise<ChatwootMessageDto>;
  /** F2: not consumed by any F1 use case; kept in the port for contract completeness. */
  searchContact(query: string): Promise<{ id: number; name: string | null; phone: string | null }[]>;
  /** Invoked ONLY by `scripts/registerChatwootWebhook.ts` (one-shot operational setup), not by app.ts. */
  registerWebhook(url: string, secret: string): Promise<void>;
}
