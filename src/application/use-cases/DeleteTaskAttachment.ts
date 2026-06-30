import { FileStorage } from '@domain/ports/FileStorage';
import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';
import { AttachmentNotFoundError } from '@domain/errors/taskAttachment';
import { THUMB_KEY_SUFFIX } from './AttachPhotosToTask';

export interface DeleteTaskAttachmentInput {
  attachmentId: string;
}

/**
 * Borra un adjunto: el binario original + el thumbnail del FileStorage (delete es
 * idempotente: borrar una key inexistente no es error) y luego la fila del repo.
 * Adjunto inexistente → AttachmentNotFoundError (404).
 */
export class DeleteTaskAttachment {
  constructor(
    private readonly attachments: TaskAttachmentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(input: DeleteTaskAttachmentInput): Promise<void> {
    const row = await this.attachments.findById(input.attachmentId);
    if (!row) throw new AttachmentNotFoundError(input.attachmentId);

    await this.fileStorage.delete(row.storageKey);
    await this.fileStorage.delete(`${row.storageKey}${THUMB_KEY_SUFFIX}`);
    await this.attachments.delete(row.id);
  }
}
