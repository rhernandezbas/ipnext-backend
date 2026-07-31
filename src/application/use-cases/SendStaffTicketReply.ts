import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketRepository } from '@domain/ports/TicketRepository';
import { FileStorage } from '@domain/ports/FileStorage';
import { TicketComment } from '@domain/entities/ticketComment';
import { TicketNotFoundError } from '@domain/errors';
import { createTicketMessageWithAttachments, TicketMessageFile } from '@application/use-cases/ticketMessageAttachments';

export interface SendStaffTicketReplyInput {
  ticketId: string;
  authorId: string;
  authorName: string;
  body: string;
  files: TicketMessageFile[];
}

/**
 * SendStaffTicketReply — portal-ticket-messaging (v2.B).
 *
 * spec "La visibilidad la determina la RUTA, no el payload" (diseño ajustado a
 * pedido del usuario): este use case SIEMPRE crea `authorKind: 'staff'` +
 * `visibility: 'public'` — literales FIJOS, nunca un parámetro. Es la
 * CONTRAPARTE de `AddTicketComment` (que sigue siendo el camino de la nota
 * interna, `staff`+`internal` fijo del otro lado): dos use cases, dos rutas
 * admin distintas, cada uno con su valor cableado. Nada en `SendStaffTicketReplyInput`
 * permite convertir esto en una nota interna — el estado ilegal es irrepresentable.
 */
export class SendStaffTicketReply {
  constructor(
    private readonly comments: TicketCommentRepository,
    private readonly ticketRepo: TicketRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(input: SendStaffTicketReplyInput): Promise<TicketComment> {
    const ticket = await this.ticketRepo.getById(input.ticketId);
    if (!ticket) throw new TicketNotFoundError(input.ticketId);

    return createTicketMessageWithAttachments(this.comments, this.fileStorage, {
      ticketId: input.ticketId,
      authorId: input.authorId,
      authorKind: 'staff',
      visibility: 'public',
      authorName: input.authorName,
      body: input.body,
      files: input.files,
    });
  }
}
