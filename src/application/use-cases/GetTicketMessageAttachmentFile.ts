import { FileStorage } from '@domain/ports/FileStorage';
import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { DomainError } from '@domain/errors';
import { TicketMessageAttachmentNotFoundError, TicketMessageStorageUnavailableError } from '@domain/errors/ticketMessage';
import type { TicketMessageLogger } from '@application/use-cases/ticketMessageAttachments';

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
 *
 * G10 (fix wave FINAL) — F11/G9 envolvían el 503 de MinIO SOLO en la
 * ESCRITURA (`createTicketMessageWithAttachments`); la LECTURA (acá) llamaba
 * a `fileStorage.get` sin try/catch — un MinIO caído tiraba el error crudo
 * (ECONNREFUSED/timeout), no-domain, y `errorHandler` caía al 500 genérico
 * en vez de un 503 honesto. Mismo criterio que la escritura: envolver en
 * `TicketMessageStorageUnavailableError` (mensaje genérico, el detalle va al
 * log), sin tocar el contrato existente (`null`/`get` que devuelve vacío
 * sigue siendo "no existe" → 404, no 503).
 */
export class GetTicketMessageAttachmentFile {
  constructor(
    private readonly comments: TicketCommentRepository,
    private readonly fileStorage: FileStorage,
    private readonly logger: TicketMessageLogger = console,
  ) {}

  async execute(attachmentId: string): Promise<TicketMessageAttachmentFile> {
    const attachment = await this.comments.findAttachmentById(attachmentId);
    if (!attachment || !attachment.storageKey) throw new TicketMessageAttachmentNotFoundError(attachmentId);

    let stored;
    try {
      stored = await this.fileStorage.get(attachment.storageKey);
    } catch (storageErr) {
      if (storageErr instanceof DomainError) throw storageErr;
      const detail = String((storageErr as Error)?.message ?? storageErr);
      this.logger.warn(`[GetTicketMessageAttachmentFile] storage unavailable while reading "${attachment.storageKey}": ${detail}`);
      throw new TicketMessageStorageUnavailableError(detail);
    }
    if (!stored) throw new TicketMessageAttachmentNotFoundError(attachmentId);

    return { buffer: stored.buffer, mimeType: stored.mimeType, filename: attachment.filename };
  }
}
