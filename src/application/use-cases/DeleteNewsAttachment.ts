import { FileStorage } from '@domain/ports/FileStorage';
import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import { NewsAttachmentNotFoundError } from '@domain/errors/newsAttachment';

export interface DeleteNewsAttachmentInput {
  attachmentId: string;
}

/**
 * Borra un adjunto de noticia: el binario del FileStorage (si lo tiene — un 'link' no lo
 * tiene; delete es idempotente) y luego la fila del repo. Adjunto inexistente → 404.
 */
export class DeleteNewsAttachment {
  constructor(
    private readonly attachments: NewsPostAttachmentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(input: DeleteNewsAttachmentInput): Promise<void> {
    const row = await this.attachments.findById(input.attachmentId);
    if (!row) throw new NewsAttachmentNotFoundError(input.attachmentId);

    if (row.storageKey) {
      await this.fileStorage.delete(row.storageKey);
    }
    await this.attachments.delete(row.id);
  }
}
