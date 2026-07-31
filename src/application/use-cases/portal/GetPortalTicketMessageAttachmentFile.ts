import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { TicketMessageAttachmentFile } from '@application/use-cases/GetTicketMessageAttachmentFile';

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
 */
export class GetPortalTicketMessageAttachmentFile {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly comments: TicketCommentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(clientId: string, ticketNumber: number, attachmentId: string): Promise<TicketMessageAttachmentFile | null> {
    const ticket = await this.tickets.getBySequenceNumber(ticketNumber);
    if (!ticket || ticket.customerId !== clientId) return null;

    const attachment = await this.comments.findAttachmentById(attachmentId);
    if (!attachment || !attachment.storageKey) return null;
    if (attachment.ticketId !== ticket.id) return null;
    if (attachment.visibility !== 'public') return null;

    const stored = await this.fileStorage.get(attachment.storageKey);
    if (!stored) return null;

    return { buffer: stored.buffer, mimeType: stored.mimeType, filename: attachment.filename };
  }
}
