import { Message } from '@domain/entities/message';
import { MessageRepository } from '@domain/ports/MessageRepository';
import { prisma } from '../../database/prisma';

function toMessage(row: any): Message {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    fromId: row.fromId,
    fromName: row.fromName,
    toId: row.toId ?? null,
    toName: row.toName ?? null,
    clientId: row.clientId ?? null,
    channel: row.channel,
    status: row.status,
    threadId: row.threadId ?? null,
    sentAt: row.sentAt
      ? (row.sentAt instanceof Date ? row.sentAt.toISOString() : row.sentAt)
      : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class InMemoryMessageRepository implements MessageRepository {
  async findAll(filter?: 'inbox' | 'sent' | 'draft'): Promise<Message[]> {
    let where: any = {};
    if (filter === 'inbox') where.status = { in: ['unread', 'read'] };
    else if (filter === 'sent') where.status = 'sent';
    else if (filter === 'draft') where.status = 'draft';

    const rows = await prisma.message.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toMessage);
  }

  async findById(id: string): Promise<Message | null> {
    const row = await prisma.message.findUnique({ where: { id } });
    return row ? toMessage(row) : null;
  }

  async create(data: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    const row = await prisma.message.create({
      data: {
        subject: data.subject,
        body: data.body,
        fromId: data.fromId,
        fromName: data.fromName,
        toId: data.toId ?? null,
        toName: data.toName ?? null,
        clientId: data.clientId ?? null,
        channel: data.channel,
        status: data.status,
        threadId: data.threadId ?? null,
        sentAt: data.sentAt ? new Date(data.sentAt) : null,
      },
    });
    return toMessage(row);
  }

  async markAsRead(id: string): Promise<Message | null> {
    try {
      const row = await prisma.message.update({
        where: { id },
        data: { status: 'read' },
      });
      return toMessage(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.message.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
