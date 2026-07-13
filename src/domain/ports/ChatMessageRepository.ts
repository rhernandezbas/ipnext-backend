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
  /** messaging-inbox-notes (F1.5 fase D, NOTE-1) — always present (defaults false). */
  isPrivate: boolean;
}

export interface UpsertChatMessageInput {
  conversationId: string;
  chatwootMessageId: number;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName?: string | null;
  chatwootCreatedAt: string;
  /** messaging-inbox-notes (F1.5 fase D, NOTE-1) — optional, defaults to false when absent. */
  isPrivate?: boolean;
}

export interface ChatMessageRepository {
  /** Idempotent by `chatwootMessageId` (HOOK-4/INBOX-2) — re-processing the same message never duplicates. */
  upsertByChatwootMessageId(input: UpsertChatMessageInput): Promise<ChatMessageRecord>;
  /** INBOX-3 — full history, ordered by `chatwootCreatedAt` ASC (oldest first). */
  listByConversation(conversationId: string): Promise<ChatMessageRecord[]>;
  /**
   * messaging-inbox-v2-media (Tanda 1 · MEDIA-2) — resolves a message's own mirror
   * row by its (internal) id. `DownloadChatMessageAttachment` uses this to recover
   * `conversationId` for the storage key (`messaging/{conversationId}/{attachmentId}.ext`).
   */
  findById(id: string): Promise<ChatMessageRecord | null>;
}
