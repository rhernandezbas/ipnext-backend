/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B1) — mirror row of
 * `ChatMessageAttachment` (spec.md MODEL-1). Dates are ISO 8601 strings, same
 * convention as `ChatMessageRecord`/`ConversationRecord`.
 *
 * NEVER cross this record straight through a DTO/route — `application/dto/messaging.ts`
 * maps it to `ChatMessageAttachmentDto`, which drops `storageKey`/`thumbStorageKey`/
 * `sourceUrl`/`thumbSourceUrl`/`lastError`/`downloadAttempts` (spec MEDIA-4).
 */
export interface ChatMessageAttachmentRecord {
  id: string;
  messageId: string;
  /** Chatwoot's own attachment id — idempotency key (`@@unique`, same criterion as `chatwootMessageId`). */
  chatwootAttachmentId: number;
  /** 'image' | 'audio' | 'video' | 'file' — a plain string, same criterion as `ChatMessage.direction`. */
  fileType: string;
  contentType: string;
  filename: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  /** NULL while `status='pending'`. Filled once the binary lands in MinIO. */
  storageKey: string | null;
  /** Only for `fileType==='image'`. NULL for audio/video/file. */
  thumbStorageKey: string | null;
  /** Chatwoot's `data_url` (301-stable, verified live to need no `api_access_token`). */
  sourceUrl: string;
  /** Chatwoot's `thumb_url`, only for `fileType==='image'`. */
  thumbSourceUrl: string | null;
  status: 'pending' | 'downloaded' | 'failed';
  downloadAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertChatMessageAttachmentInput {
  messageId: string;
  chatwootAttachmentId: number;
  fileType: string;
  contentType: string;
  filename?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  sourceUrl: string;
  thumbSourceUrl?: string | null;
}

export interface ListRetriableOptions {
  /** Only rows with `downloadAttempts < maxAttempts` are eligible (MEDIA-3, abandon at 5). */
  maxAttempts: number;
  limit?: number;
}

export interface MarkDownloadedInput {
  storageKey: string;
  thumbStorageKey?: string | null;
}

export interface MarkFailedInput {
  error: string;
}

/**
 * Repository for `ChatMessageAttachment` rows (spec MODEL-1/MEDIA-1/2/3).
 * Adapters: `PrismaChatMessageAttachmentRepository` (prod), `InMemoryChatMessageAttachmentRepository`
 * (tests — never mock Prisma directly, CLAUDE.md convention).
 */
export interface ChatMessageAttachmentRepository {
  /**
   * Idempotent by `chatwootAttachmentId` (MEDIA-1, scenario 1/2). Insert-if-new;
   * on a repeat delivery for an ALREADY `downloaded` row, MUST NOT revert `status`
   * back to `pending` nor clear `storageKey`/`thumbStorageKey`.
   */
  upsertByChatwootAttachmentId(input: UpsertChatMessageAttachmentInput): Promise<ChatMessageAttachmentRecord>;
  /** Bulk fetch by message id — anti-N+1 for `ListMessages`/`GetConversation` mappers. */
  listByMessageIds(messageIds: string[]): Promise<ChatMessageAttachmentRecord[]>;
  findById(id: string): Promise<ChatMessageAttachmentRecord | null>;
  /** MEDIA-3 — `status IN ('pending','failed') AND downloadAttempts < maxAttempts`. */
  listRetriable(options: ListRetriableOptions): Promise<ChatMessageAttachmentRecord[]>;
  markDownloaded(id: string, input: MarkDownloadedInput): Promise<ChatMessageAttachmentRecord>;
  /** Increments `downloadAttempts` by 1 and sets `lastError`. */
  markFailed(id: string, input: MarkFailedInput): Promise<ChatMessageAttachmentRecord>;
}
