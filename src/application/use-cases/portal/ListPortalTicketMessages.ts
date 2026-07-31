import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { PortalTicketMessageDto, toPortalTicketMessageDto } from '@application/dto/portal/portalTicketMessage.dto';

/**
 * ListPortalTicketMessages — portal-ticket-messaging (v2.B).
 *
 * spec "El cliente lee y escribe en SU reclamo": resuelve el ticket por
 * `sequenceNumber` (mismo patrón anti-IDOR que `GetPortalTicket` — `null`
 * cubre TANTO "no existe" COMO "es de otro cliente", 404 indistinguible lo
 * decide la ruta). Lee EXCLUSIVAMENTE vía `listPublicByTicket` (nunca
 * `listByTicket`) — ese es el único punto donde vive el invariante central.
 *
 * "Abrir el hilo" (este GET) marca `clientMessagesReadAt` — spec "No leídos por
 * lado": el contador se limpia al abrir, nunca al escribir un mensaje propio.
 * Solo se marca cuando el ticket REALMENTE es del cliente (un intento sobre un
 * ticket ajeno no debe dejar rastro de "abrió" nada que nunca abrió).
 */
export class ListPortalTicketMessages {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly comments: TicketCommentRepository,
  ) {}

  async execute(clientId: string, ticketNumber: number): Promise<PortalTicketMessageDto[] | null> {
    const ticket = await this.tickets.getBySequenceNumber(ticketNumber);
    if (!ticket || ticket.customerId !== clientId) return null;

    const publicComments = await this.comments.listPublicByTicket(ticket.id);
    // F5 (fix wave) — el cursor se estampa con el createdAt del ÚLTIMO mensaje
    // efectivamente listado arriba, NUNCA con `now()`: entre el
    // `listPublicByTicket` y el `markMessagesRead` puede aterrizar un mensaje
    // nuevo (el operador responde justo en ese instante) — con `now()` ese
    // mensaje quedaría marcado leído sin haber estado nunca en ESTA respuesta.
    // Lista vacía: no hay mensaje del cual anclar el cursor — se preserva acá
    // el comportamiento previo (now()) para no perder el contrato "abrir el
    // hilo limpia el badge incluso sin mensajes" (ver test dedicado); la
    // ventana de carrera remanente en ese caso queda acotada al borde
    // 0→primer mensaje, no al caso general (mucho más frecuente) de un hilo
    // con mensajes existentes, que es el que se reportó.
    const at = publicComments.length > 0
      ? new Date(publicComments[publicComments.length - 1]!.createdAt)
      : new Date();
    await this.tickets.markMessagesRead(ticket.id, 'client', at);

    const attachmentUrlPrefix = `/api/portal/tickets/${ticketNumber}/messages/attachments`;
    return publicComments.map((c) => toPortalTicketMessageDto(c, attachmentUrlPrefix));
  }
}
