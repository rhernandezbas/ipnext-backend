import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketComment, TicketCommentAttachment } from '@domain/entities/ticketComment';
import { prisma } from '../../database/prisma';

function toAttachment(row: {
  id: string;
  commentId: string;
  url: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}): TicketCommentAttachment {
  return {
    id: row.id,
    commentId: row.commentId,
    url: row.url,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
  };
}

function toComment(row: {
  id: string;
  ticketId: string;
  authorName: string;
  body: string;
  createdAt: Date | string;
  attachments: Array<{
    id: string;
    commentId: string;
    url: string;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
  }>;
}): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    attachments: row.attachments.map(toAttachment),
  };
}

export class PrismaTicketCommentRepository implements TicketCommentRepository {
  async listByTicket(ticketId: string): Promise<TicketComment[]> {
    const rows = await prisma.ticketComment.findMany({
      where: { ticketId },
      // id is the deterministic tiebreaker when createdAt collides.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { attachments: true },
    });
    return rows.map(toComment);
  }

  async create(comment: TicketComment): Promise<TicketComment> {
    const row = await prisma.ticketComment.create({
      data: {
        id: comment.id,
        ticketId: comment.ticketId,
        authorName: comment.authorName,
        body: comment.body,
        attachments: {
          create: comment.attachments.map((a) => ({
            id: a.id,
            url: a.url,
            filename: a.filename,
            mimeType: a.mimeType ?? null,
            sizeBytes: a.sizeBytes ?? null,
          })),
        },
      },
      include: { attachments: true },
    });
    return toComment(row);
  }
}
