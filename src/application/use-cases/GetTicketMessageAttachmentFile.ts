import { FileStorage } from '@domain/ports/FileStorage';
import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketMessageAttachmentNotFoundError } from '@domain/errors/ticketMessage';

export interface TicketMessageAttachmentFile {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * GetTicketMessageAttachmentFile — portal-ticket-messaging (v2.B), lado ADMIN.
 *
 * El staff ve CUALQUIER adjunto de mensajería (público o de una nota interna),
 * a diferencia del portal (`GetPortalTicketMessageAttachmentFile`), que además
 * exige `visibility=public` y pertenencia al cliente. Molde EXACTO de
 * `GetNewsAttachmentFile`: 404 si no existe, si es un adjunto viejo (sin
 * `storageKey`, ver ticketComment.ts), o si el binario no está en el storage.
 */
export class GetTicketMessageAttachmentFile {
  constructor(
    private readonly comments: TicketCommentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(attachmentId: string): Promise<TicketMessageAttachmentFile> {
    const attachment = await this.comments.findAttachmentById(attachmentId);
    if (!attachment || !attachment.storageKey) throw new TicketMessageAttachmentNotFoundError(attachmentId);

    const stored = await this.fileStorage.get(attachment.storageKey);
    if (!stored) throw new TicketMessageAttachmentNotFoundError(attachmentId);

    return { buffer: stored.buffer, mimeType: stored.mimeType, filename: attachment.filename };
  }
}
