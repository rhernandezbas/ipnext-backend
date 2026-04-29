import { Notification } from '@domain/entities/notification';
import { NotificationRepository } from '@domain/ports/NotificationRepository';
import { prisma } from '../../database/prisma';

function toNotification(row: any): Notification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    severity: row.severity,
    read: row.read,
    link: row.link ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    readAt: row.readAt
      ? (row.readAt instanceof Date ? row.readAt.toISOString() : row.readAt)
      : null,
  };
}

export class InMemoryNotificationRepository implements NotificationRepository {
  async findAll(unreadOnly?: boolean): Promise<Notification[]> {
    const rows = await prisma.notification.findMany({
      where: unreadOnly ? { read: false } : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toNotification);
  }

  async markAsRead(id: string): Promise<Notification | null> {
    try {
      const row = await prisma.notification.update({
        where: { id },
        data: { read: true, readAt: new Date() },
      });
      return toNotification(row);
    } catch {
      return null;
    }
  }

  async markAllAsRead(): Promise<void> {
    const now = new Date();
    await prisma.notification.updateMany({
      where: { read: false },
      data: { read: true, readAt: now },
    });
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.notification.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
