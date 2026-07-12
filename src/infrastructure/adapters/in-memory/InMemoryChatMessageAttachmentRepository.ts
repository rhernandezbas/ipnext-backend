import { randomUUID } from 'crypto';
import {
  ChatMessageAttachmentRepository,
  ChatMessageAttachmentRecord,
  UpsertChatMessageAttachmentInput,
  ListRetriableOptions,
  MarkDownloadedInput,
  MarkFailedInput,
} from '@domain/ports/ChatMessageAttachmentRepository';
import { ChatAttachmentNotFoundError } from '@domain/errors/chatAttachment';

/**
 * In-memory `ChatMessageAttachmentRepository` for use-case/scheduler tests
 * (messaging-inbox-v2-media, Tanda 1 · B1.4). Dedup key mirrors the Prisma
 * `@@unique` on `chatwootAttachmentId` (MEDIA-1, scenario 1/2).
 */
export class InMemoryChatMessageAttachmentRepository implements ChatMessageAttachmentRepository {
  private rows: ChatMessageAttachmentRecord[] = [];

  async upsertByChatwootAttachmentId(
    input: UpsertChatMessageAttachmentInput,
  ): Promise<ChatMessageAttachmentRecord> {
    const existing = this.rows.find((r) => r.chatwootAttachmentId === input.chatwootAttachmentId);
    const now = new Date().toISOString();

    if (existing) {
      // Scenario 2 — an already-`downloaded` row is NOT reverted to `pending`, and its
      // storageKey/thumbStorageKey are NOT cleared. Only metadata that Chatwoot may have
      // corrected (contentType/filename/dimensions/sourceUrl) is refreshed.
      existing.messageId = input.messageId;
      existing.fileType = input.fileType;
      existing.contentType = input.contentType;
      existing.filename = input.filename ?? existing.filename ?? null;
      existing.sizeBytes = input.sizeBytes ?? existing.sizeBytes ?? null;
      existing.width = input.width ?? existing.width ?? null;
      existing.height = input.height ?? existing.height ?? null;
      existing.sourceUrl = input.sourceUrl;
      existing.thumbSourceUrl = input.thumbSourceUrl ?? existing.thumbSourceUrl ?? null;
      existing.updatedAt = now;
      return { ...existing };
    }

    const row: ChatMessageAttachmentRecord = {
      id: randomUUID(),
      messageId: input.messageId,
      chatwootAttachmentId: input.chatwootAttachmentId,
      fileType: input.fileType,
      contentType: input.contentType,
      filename: input.filename ?? null,
      sizeBytes: input.sizeBytes ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      storageKey: null,
      thumbStorageKey: null,
      sourceUrl: input.sourceUrl,
      thumbSourceUrl: input.thumbSourceUrl ?? null,
      status: 'pending',
      downloadAttempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async listByMessageIds(messageIds: string[]): Promise<ChatMessageAttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    const set = new Set(messageIds);
    return this.rows.filter((r) => set.has(r.messageId)).map((r) => ({ ...r }));
  }

  async findById(id: string): Promise<ChatMessageAttachmentRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async listRetriable(options: ListRetriableOptions): Promise<ChatMessageAttachmentRecord[]> {
    return this.rows
      .filter(
        (r) =>
          (r.status === 'pending' || r.status === 'failed') &&
          r.downloadAttempts < options.maxAttempts,
      )
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER)
      .map((r) => ({ ...r }));
  }

  async markDownloaded(id: string, input: MarkDownloadedInput): Promise<ChatMessageAttachmentRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new ChatAttachmentNotFoundError(id);
    row.status = 'downloaded';
    row.storageKey = input.storageKey;
    row.thumbStorageKey = input.thumbStorageKey ?? null;
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }

  async markFailed(id: string, input: MarkFailedInput): Promise<ChatMessageAttachmentRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new ChatAttachmentNotFoundError(id);
    // fix-be #2 (MEDIUM) — the fire-and-forget (web process) and the scheduler (or
    // another replica) can race on the SAME row: if the fire-and-forget already won
    // with `markDownloaded`, a slower/stale `markFailed` from the loser must NOT
    // revert `status` back to `failed` nor touch `downloadAttempts`/`lastError` —
    // mirrors the atomic `updateMany({where:{status:{not:'downloaded'}}})` guard in
    // `PrismaChatMessageAttachmentRepository`.
    if (row.status === 'downloaded') return { ...row };
    row.status = 'failed';
    row.downloadAttempts += 1;
    row.lastError = input.error;
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }
}
