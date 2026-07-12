/**
 * messaging-inbox (F1) — mirror row of `ChatMessage` (design §1). Dates are
 * ISO 8601 strings (same convention as `ConversationRecord`).
 */
export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  chatwootMessageId: number;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName: string | null;
  chatwootCreatedAt: string;
  createdAt: string;
}

export interface UpsertChatMessageInput {
  conversationId: string;
  chatwootMessageId: number;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName?: string | null;
  chatwootCreatedAt: string;
}

export interface ChatMessageRepository {
  /** Idempotent by `chatwootMessageId` (HOOK-4/INBOX-2) — re-processing the same message never duplicates. */
  upsertByChatwootMessageId(input: UpsertChatMessageInput): Promise<ChatMessageRecord>;
  /** INBOX-3 — full history, ordered by `chatwootCreatedAt` ASC (oldest first). */
  listByConversation(conversationId: string): Promise<ChatMessageRecord[]>;
}
