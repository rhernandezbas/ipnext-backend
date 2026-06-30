import { FileStorage } from '@domain/ports/FileStorage';
import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';
import { AttachmentNotFoundError } from '@domain/errors/taskAttachment';
import { THUMB_KEY_SUFFIX } from './AttachPhotosToTask';

export type AttachmentVariant = 'original' | 'thumb';

export interface GetTaskAttachmentFileInput {
  attachmentId: string;
  variant: AttachmentVariant;
}

/** Binario resuelto para que la ruta lo streamee. */
export interface TaskAttachmentFile {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Resuelve el binario de un adjunto (original o thumbnail) desde el FileStorage.
 *
 * Para `variant: 'thumb'` intenta primero la key del thumb; si no existe (foto vieja
 * subida antes del thumbnail), cae al original. Adjunto inexistente, o binario
 * ausente en el storage → AttachmentNotFoundError (404).
 */
export class GetTaskAttachmentFile {
  constructor(
    private readonly attachments: TaskAttachmentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(input: GetTaskAttachmentFileInput): Promise<TaskAttachmentFile> {
    const row = await this.attachments.findById(input.attachmentId);
    if (!row) throw new AttachmentNotFoundError(input.attachmentId);

    if (input.variant === 'thumb') {
      const thumb = await this.fileStorage.get(`${row.storageKey}${THUMB_KEY_SUFFIX}`);
      if (thumb) {
        return { buffer: thumb.buffer, mimeType: thumb.mimeType, filename: row.filename };
      }
      // sin thumb (foto vieja) → fallback al original
    }

    const original = await this.fileStorage.get(row.storageKey);
    if (!original) throw new AttachmentNotFoundError(input.attachmentId);
    return { buffer: original.buffer, mimeType: original.mimeType, filename: row.filename };
  }
}
