import type { ChatMessageAttachmentRepository } from '@domain/ports/ChatMessageAttachmentRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import { ChatAttachmentNotFoundError, ChatAttachmentNotReadyError } from '@domain/errors/chatAttachment';

export type ChatAttachmentVariant = 'original' | 'thumb';

export interface GetChatAttachmentFileInput {
  attachmentId: string;
  variant: ChatAttachmentVariant;
}

/** Binario resuelto para que la ruta lo streamee. */
export interface ChatAttachmentFile {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /**
   * fix-be #3 (MEDIUM) — the row's `fileType` ('image'|'audio'|'video'|'file'),
   * NOT the client-reported `mimeType`: the route uses this (not `mimeType`) to
   * decide `Content-Disposition: inline` vs `attachment`. A 'file' (arbitrary
   * WhatsApp document) can carry ANY `content_type` a malicious sender chooses
   * (e.g. `text/html`) — trusting `mimeType` alone for the inline decision is
   * exactly the stored-XSS gap this field closes.
   */
  fileType: string;
}

/**
 * GetChatAttachmentFile (messaging-inbox-v2-media, Tanda 1 · MEDIA-5) — clon de
 * `GetTaskAttachmentFile`. Resuelve el binario de un `ChatMessageAttachment`
 * (original o thumbnail) desde `FileStorage`, resolviendo SIEMPRE por el `id`
 * propio del attachment (nunca acepta una `storageKey`/URL cruda como input —
 * spec §Seguridad).
 *
 * `variant: 'thumb'` sin `thumbStorageKey` cae al original (mismo fallback que
 * `ScheduledTaskAttachmentDto`). `status !== 'downloaded'` → `ChatAttachmentNotReadyError`
 * (409) SIN tocar MinIO. Id inexistente → `ChatAttachmentNotFoundError` (404).
 */
export class GetChatAttachmentFile {
  constructor(
    private readonly attachments: ChatMessageAttachmentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(input: GetChatAttachmentFileInput): Promise<ChatAttachmentFile> {
    const row = await this.attachments.findById(input.attachmentId);
    if (!row) throw new ChatAttachmentNotFoundError(input.attachmentId);

    // 409 BEFORE touching MinIO (scenario 20) — pending/failed never had a binary saved.
    if (row.status !== 'downloaded' || !row.storageKey) {
      throw new ChatAttachmentNotReadyError(input.attachmentId, row.status);
    }

    const filename = row.filename ?? `attachment-${row.id}`;

    if (input.variant === 'thumb' && row.thumbStorageKey) {
      const thumb = await this.fileStorage.get(row.thumbStorageKey);
      if (thumb) return { buffer: thumb.buffer, mimeType: thumb.mimeType, filename, fileType: row.fileType };
      // thumb key set but object missing in storage — degrade to the original below.
    }

    const original = await this.fileStorage.get(row.storageKey);
    if (!original) throw new ChatAttachmentNotFoundError(input.attachmentId);
    return { buffer: original.buffer, mimeType: original.mimeType, filename, fileType: row.fileType };
  }
}
