import { TicketCommentRepository, TicketCommentAttachmentWithContext } from '@domain/ports/TicketCommentRepository';
import {
  TicketComment,
  TicketCommentAttachment,
  TicketCommentAuthorKind,
  TicketCommentVisibility,
  TicketCommentAttachmentKind,
} from '@domain/entities/ticketComment';
import { prisma } from '../../database/prisma';

function toAttachment(row: {
  id: string;
  commentId: string;
  url: string | null;
  storageKey: string | null;
  kind: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}): TicketCommentAttachment {
  return {
    id: row.id,
    commentId: row.commentId,
    url: row.url,
    storageKey: row.storageKey,
    kind: (row.kind as TicketCommentAttachmentKind | null) ?? null,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
  };
}

function toComment(row: {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorKind: string;
  visibility: string;
  authorName: string;
  body: string;
  createdAt: Date | string;
  attachments: Array<{
    id: string;
    commentId: string;
    url: string | null;
    storageKey: string | null;
    kind: string | null;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
  }>;
}): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorId: row.authorId,
    authorKind: row.authorKind as TicketCommentAuthorKind,
    visibility: row.visibility as TicketCommentVisibility,
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

  /**
   * portal-ticket-messaging (v2.B) — INVARIANTE CENTRAL: `visibility: 'public'` en
   * el WHERE de la query, no en un filtro posterior. Esta es la única lectura que
   * el portal debe usar — ver el docblock del port.
   */
  async listPublicByTicket(ticketId: string): Promise<TicketComment[]> {
    const rows = await prisma.ticketComment.findMany({
      where: { ticketId, visibility: 'public' },
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
        authorId: comment.authorId ?? null,
        authorKind: comment.authorKind,
        visibility: comment.visibility,
        authorName: comment.authorName,
        body: comment.body,
        attachments: {
          create: comment.attachments.map((a) => ({
            id: a.id,
            url: a.url ?? null,
            storageKey: a.storageKey ?? null,
            kind: a.kind ?? null,
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

  async countUnread(ticketId: string, side: 'client' | 'staff', since: Date | null): Promise<number> {
    const sinceClause = since ? { gt: since } : undefined;
    if (side === 'client') {
      return prisma.ticketComment.count({
        where: {
          ticketId,
          visibility: 'public',
          authorKind: 'staff',
          ...(sinceClause ? { createdAt: sinceClause } : {}),
        },
      });
    }
    return prisma.ticketComment.count({
      where: {
        ticketId,
        authorKind: 'client',
        ...(sinceClause ? { createdAt: sinceClause } : {}),
      },
    });
  }

  async findAttachmentById(attachmentId: string): Promise<TicketCommentAttachmentWithContext | null> {
    const row = await prisma.ticketCommentAttachment.findUnique({
      where: { id: attachmentId },
      include: { comment: { select: { ticketId: true, visibility: true } } },
    });
    if (!row) return null;
    return {
      ...toAttachment(row),
      ticketId: row.comment.ticketId,
      visibility: row.comment.visibility as TicketCommentVisibility,
    };
  }
}
