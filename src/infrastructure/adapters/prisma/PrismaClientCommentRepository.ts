import { ClientCommentRepository } from '@domain/ports/ClientCommentRepository';
import { ClientComment } from '@domain/entities/customer';
import { prisma } from '../../database/prisma';

function toComment(row: any): ClientComment {
  return {
    id: row.id,
    clientId: row.clientId,
    authorName: row.authorName,
    content: row.content,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class InMemoryClientCommentRepository implements ClientCommentRepository {
  async findByClientId(clientId: string): Promise<ClientComment[]> {
    const rows = await prisma.clientComment.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toComment);
  }

  async create(comment: ClientComment): Promise<ClientComment> {
    const row = await prisma.clientComment.create({
      data: {
        id: comment.id,
        clientId: comment.clientId,
        authorName: comment.authorName,
        content: comment.content,
      },
    });
    return toComment(row);
  }
}
