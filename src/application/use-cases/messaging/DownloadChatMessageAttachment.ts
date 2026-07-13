import type { ChatMessageAttachmentRepository } from '@domain/ports/ChatMessageAttachmentRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { FileStorage } from '@domain/ports/FileStorage';

/**
 * MEDIA-2 — per-`fileType` size ceilings (bytes), re-validated in THIS use case
 * (multer, on the RECEIVE side, only enforces a single flat ceiling — it cannot
 * vary by type).
 *
 * **Exported** (Tanda 2 · BE2.17, decision confirmed) as the SINGLE SOURCE OF TRUTH
 * for this ceiling table: `SendMessage.ts` (the SEND path) imports and reuses this
 * exact constant instead of duplicating it — a duplicate table would drift the two
 * directions apart silently.
 */
export const MAX_BYTES_BY_FILE_TYPE: Record<string, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  file: 100 * 1024 * 1024,
};
/** Conservative default for any future/unknown fileType — same ceiling as documents. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function maxBytesFor(fileType: string): number {
  return MAX_BYTES_BY_FILE_TYPE[fileType] ?? DEFAULT_MAX_BYTES;
}

/** Best-effort extension from the MIME type — falls back to 'bin' rather than throwing. */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function extensionFor(contentType: string): string {
  const known = EXTENSION_BY_CONTENT_TYPE[contentType];
  if (known) return known;
  const subtype = contentType.split('/')[1];
  if (subtype && /^[a-z0-9.+-]+$/i.test(subtype)) return subtype.split('+')[0]!;
  return 'bin';
}

/**
 * DownloadChatMessageAttachment (messaging-inbox-v2-media, Tanda 1 · MEDIA-2) —
 * downloads a `pending`/`failed` `ChatMessageAttachment`'s binary from Chatwoot,
 * re-validates size by `fileType`, stores it in `FileStorage`, downloads the
 * thumbnail too (`fileType==='image'` only), and marks the row `downloaded`. Any
 * failure (network, size, missing storage config) ends in `markFailed` — NEVER an
 * unhandled exception, NEVER an intermediate state. Idempotent: a row already
 * `downloaded` is a pure no-op (no re-download, no re-upload).
 *
 * Invoked by two triggers (design §Flujo): the webhook's fire-and-forget
 * (`ChatMediaDownloadTrigger`) and `ChatMediaDownloadScheduler`'s periodic sweep.
 * Both call `execute(attachmentId)` — this is the single place the actual
 * download/validate/store logic lives.
 */
export class DownloadChatMessageAttachment {
  constructor(
    private readonly attachments: ChatMessageAttachmentRepository,
    private readonly messages: ChatMessageRepository,
    private readonly gateway: ChatwootGateway,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(attachmentId: string): Promise<void> {
    const row = await this.attachments.findById(attachmentId);
    if (!row) return; // deleted/unknown id — nothing to do, never throws (scheduler-tolerant)
    if (row.status === 'downloaded') return; // scenario 10 — already done, no re-download

    const maxBytes = maxBytesFor(row.fileType);

    try {
      // Fail-fast on Chatwoot's REPORTED size — scenario 7, never hits the network.
      if (row.sizeBytes !== null && row.sizeBytes > maxBytes) {
        throw new Error(
          `Attachment of type "${row.fileType}" (${row.sizeBytes} reported bytes) exceeds the maximum of ${maxBytes} bytes`,
        );
      }

      const message = await this.messages.findById(row.messageId);
      const conversationId = message?.conversationId ?? row.messageId; // defensive fallback, never throws on a dangling ref

      // fix-be #1 (HIGH) — forward the per-fileType ceiling so the GATEWAY can abort
      // mid-stream (axios maxContentLength/maxBodyLength) instead of buffering the
      // whole body before this use case gets to re-validate size below.
      const original = await this.gateway.downloadAttachment(row.sourceUrl, { maxBytes });

      // Re-validate against the REAL bytes — Chatwoot's reported size can be absent or wrong.
      if (original.buffer.length > maxBytes) {
        throw new Error(
          `Attachment of type "${row.fileType}" (${original.buffer.length} downloaded bytes) exceeds the maximum of ${maxBytes} bytes`,
        );
      }

      const extension = extensionFor(original.contentType || row.contentType);
      const storageKey = `messaging/${conversationId}/${row.id}.${extension}`;
      await this.fileStorage.save({ key: storageKey, buffer: original.buffer, mimeType: original.contentType });

      let thumbStorageKey: string | null = null;
      if (row.fileType === 'image' && row.thumbSourceUrl) {
        // Best-effort: a thumbnail download failure must NOT fail the whole attachment —
        // the original is already safely stored; the FE falls back to the original (design §Endpoint).
        try {
          const thumb = await this.gateway.downloadAttachment(row.thumbSourceUrl, { maxBytes });
          const thumbExtension = extensionFor(thumb.contentType || original.contentType);
          thumbStorageKey = `messaging/${conversationId}/${row.id}-thumb.${thumbExtension}`;
          await this.fileStorage.save({ key: thumbStorageKey, buffer: thumb.buffer, mimeType: thumb.contentType });
        } catch (thumbErr) {
          console.error('[messaging] thumbnail download failed (original already stored, degrading gracefully)', {
            attachmentId: row.id,
            error: thumbErr,
          });
          thumbStorageKey = null;
        }
      }

      await this.attachments.markDownloaded(row.id, { storageKey, thumbStorageKey });
    } catch (err) {
      await this.attachments.markFailed(row.id, { error: (err as Error).message });
    }
  }
}
