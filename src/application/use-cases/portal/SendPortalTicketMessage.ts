import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import { PortalTicketMessageDto, toPortalTicketMessageDto } from '@application/dto/portal/portalTicketMessage.dto';
import { createTicketMessageWithAttachments, TicketMessageFile } from '@application/use-cases/ticketMessageAttachments';

export interface SendPortalTicketMessageInput {
  body: string;
  files: TicketMessageFile[];
}

/**
 * SendPortalTicketMessage — portal-ticket-messaging (v2.B).
 *
 * spec "El cliente lee y escribe en SU reclamo" + "La visibilidad la determina
 * la RUTA, no el payload" (diseño ajustado a pedido del usuario): este use case
 * SIEMPRE crea `authorKind: 'client'` + `visibility: 'public'` — son literales
 * FIJOS acá adentro, nunca parámetros del input. No hay ningún campo que un
 * caller pueda setear para cambiar eso (el estado ilegal — un "mensaje interno
 * del cliente" — es irrepresentable: la interfaz `SendPortalTicketMessageInput`
 * ni siquiera tiene un campo `visibility`).
 *
 * `authorName` se estampa como el literal 'Cliente' (no 'Cliente #<id>' ni el
 * nombre real): resolver el nombre real requeriría inyectar CustomerRepository
 * en este use case solo para ese label — dado que `authorKind` YA discrimina
 * "esto lo escribió el cliente" para el consumidor del DTO (la app/FE), el
 * nombre legible es una mejora futura de bajo valor, no bloqueante para la spec.
 */
export class SendPortalTicketMessage {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly comments: TicketCommentRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  /**
   * `accountId` != `clientId` a propósito: `clientId` es el ancla anti-IDOR
   * (pertenencia del ticket, mismo criterio que el resto del portal), `accountId`
   * (`req.portalAccountId`) es la IDENTIDAD real que se estampa como `authorId`
   * — espejo de `SendStaffTicketReply`, donde `authorId` es `req.user.id` (la
   * sesión que escribió), no un id "de grupo".
   */
  async execute(clientId: string, accountId: string, ticketNumber: number, input: SendPortalTicketMessageInput): Promise<PortalTicketMessageDto | null> {
    const ticket = await this.tickets.getBySequenceNumber(ticketNumber);
    if (!ticket || ticket.customerId !== clientId) return null;

    const comment = await createTicketMessageWithAttachments(this.comments, this.fileStorage, {
      ticketId: ticket.id,
      authorId: accountId,
      authorKind: 'client',
      visibility: 'public',
      authorName: 'Cliente',
      body: input.body,
      files: input.files,
    });

    const attachmentUrlPrefix = `/api/portal/tickets/${ticketNumber}/messages/attachments`;
    return toPortalTicketMessageDto(comment, attachmentUrlPrefix);
  }
}
