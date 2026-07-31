import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { TicketMessageAttachmentFile } from '@application/use-cases/GetTicketMessageAttachmentFile';
import { DomainError } from '@domain/errors';
import { TicketMessageStorageUnavailableError } from '@domain/errors/ticketMessage';
import type { TicketMessageLogger } from '@application/use-cases/ticketMessageAttachments';

/**
 * GetPortalTicketMessageAttachmentFile — portal-ticket-messaging (v2.B), lado
 * PORTAL.
 *
 * spec "Adjunto de un reclamo ajeno": la pertenencia se valida AL EMITIR la
 * URL, no al guardarla — acá es donde eso se ejecuta, en cada request. Triple
 * check antes de tocar el storage: (1) el ticket es del cliente del token
 * (mismo anti-IDOR que el resto del portal), (2) el adjunto pertenece a ESE
 * ticket, (3) el adjunto es `visibility=public` — el mismo invariante central
 * de la mensajería repetido acá, en capas: aunque el id de un adjunto interno
 * se filtrara por otro medio, esta ruta lo sigue rechazando. `null` cubre los
 * tres casos SIN distinguir cuál — mismo contrato 404 indistinguible que
 * `GetPortalTicket`.
 *
 * G10 (fix wave FINAL) — gemelo EXACTO del fix de
 * `GetTicketMessageAttachmentFile` (lado admin): `fileStorage.get` sin
 * try/catch dejaba pasar el error crudo de un MinIO caído (ECONNREFUSED/
 * timeout) hacia el 500 genérico de `errorHandler`. Envuelto en
 * `TicketMessageStorageUnavailableError` (503, mensaje genérico, detalle solo
 * al log) — el resto del contrato (`null` para "no existe/ajeno") no cambia.
 */
export class GetPortalTicketMessageAttachmentFile {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly comments: TicketCommentRepository,
    private readonly fileStorage: FileStorage,
    private readonly logger: TicketMessageLogger = console,
  ) {}

  async execute(clientId: string, ticketNumber: number, attachmentId: string): Promise<TicketMessageAttachmentFile | null> {
    const ticket = await this.tickets.getBySequenceNumber(ticketNumber);
    if (!ticket || ticket.customerId !== clientId) return null;

    const attachment = await this.comments.findAttachmentById(attachmentId);
    if (!attachment || !attachment.storageKey) return null;
    if (attachment.ticketId !== ticket.id) return null;
    if (attachment.visibility !== 'public') return null;

    let stored;
    try {
      stored = await this.fileStorage.get(attachment.storageKey);
    } catch (storageErr) {
      if (storageErr instanceof DomainError) throw storageErr;
      const detail = String((storageErr as Error)?.message ?? storageErr);
      this.logger.warn(`[GetPortalTicketMessageAttachmentFile] storage unavailable while reading "${attachment.storageKey}": ${detail}`);
      throw new TicketMessageStorageUnavailableError(detail);
    }
    if (!stored) return null;

    return { buffer: stored.buffer, mimeType: stored.mimeType, filename: attachment.filename };
  }
}
