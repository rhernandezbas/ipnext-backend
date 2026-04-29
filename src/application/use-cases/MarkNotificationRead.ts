import { NotificationRepository } from '@domain/ports/NotificationRepository';
import { Notification } from '@domain/entities/notification';

export class MarkNotificationRead {
  constructor(private readonly repo: NotificationRepository) {}

  execute(id: string): Promise<Notification | null> {
    return this.repo.markAsRead(id);
  }
}
