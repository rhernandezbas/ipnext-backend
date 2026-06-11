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
      filename: a.filename,
      mimeType: a.mimeType ?? null,
      sizeBytes: a.sizeBytes ?? null,
    }));

    const comment: TicketComment = {
      id: commentId,
      ticketId: input.ticketId,
      authorName: input.authorName,
      body: input.body,
      createdAt: new Date().toISOString(),
      attachments,
    };

    return this.repo.create(comment);
  }
}
