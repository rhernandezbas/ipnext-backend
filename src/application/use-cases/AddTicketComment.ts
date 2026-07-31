import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketComment, TicketCommentAttachment } from '@domain/entities/ticketComment';
import { TicketNotFoundError } from '@domain/errors';
import { randomUUID } from 'crypto';

export interface AddTicketCommentInput {
  ticketId: string;
  authorName: string;
  body: string;
  attachments: Array<{
    url: string;
    filename: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
  }>;
}

/**
 * portal-ticket-messaging (v2.B) — este use case es el camino de las NOTAS
 * INTERNAS de siempre (el CRUD admin de comentarios, `POST /api/tickets/:id/
 * comments`). `authorKind`/`visibility` se estampan FIJOS acá adentro —
 * `staff` + `internal`, SIEMPRE — y no viajan como parámetro del input: es la
 * ruta (este use case) la que determina la visibilidad, no el caller. Un
 * operador que quiera responderle AL CLIENTE usa el use case nuevo
 * `SendStaffTicketReply` (visibility=public fijo del otro lado) — dos rutas
 * distintas, cada una con su valor cableado, en vez de un campo que alguien
 * pueda setear mal.
 */
export class AddTicketComment {
  constructor(
    private readonly repo: TicketCommentRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  async execute(input: AddTicketCommentInput): Promise<TicketComment> {
    const ticket = await this.ticketRepo.getById(input.ticketId);
    if (!ticket) throw new TicketNotFoundError(input.ticketId);

    const commentId = randomUUID();
    const attachments: TicketCommentAttachment[] = input.attachments.map((a) => ({
      id: randomUUID(),
      commentId,
      url: a.url,
      storageKey: null,
      kind: null,
      filename: a.filename,
      mimeType: a.mimeType ?? null,
      sizeBytes: a.sizeBytes ?? null,
    }));

    const comment: TicketComment = {
      id: commentId,
      ticketId: input.ticketId,
      authorId: null,
      authorKind: 'staff',
      visibility: 'internal',
      authorName: input.authorName,
      body: input.body,
      createdAt: new Date().toISOString(),
      attachments,
    };

    return this.repo.create(comment);
  }
}
