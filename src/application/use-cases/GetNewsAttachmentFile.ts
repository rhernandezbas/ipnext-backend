import { FileStorage } from '@domain/ports/FileStorage';
import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import { NewsAttachmentNotFoundError } from '@domain/errors/newsAttachment';

export interface GetNewsAttachmentFileInput {
  attachmentId: string;
}

/** Binario resuelto para que la ruta lo streamee. */
export interface NewsAttachmentFile {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Resuelve el binario de un adjunto de noticia desde el FileStorage.
 *
 * Un adjunto tipo 'link' NO tiene binario → NewsAttachmentNotFoundError (404). Adjunto
 * inexistente o binario ausente en el storage → 404. Sin variante thumbnail (las noticias
 * no generan miniaturas).
 */
export class GetNewsAttachmentFile {
  constructor(
    private readonly attachments: NewsPostAttachmentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(input: GetNewsAttachmentFileInput): Promise<NewsAttachmentFile> {
    const row = await this.attachments.findById(input.attachmentId);
    if (!row || !row.storageKey) throw new NewsAttachmentNotFoundError(input.attachmentId);

    const stored = await this.fileStorage.get(row.storageKey);
    if (!stored) throw new NewsAttachmentNotFoundError(input.attachmentId);

    return {
      buffer: stored.buffer,
      mimeType: stored.mimeType,
      filename: row.filename ?? 'archivo',
    };
  }
}
