import { NotificationRepository } from '@domain/ports/NotificationRepository';
import { Notification } from '@domain/entities/notification';

export class ListNotifications {
  constructor(private readonly repo: NotificationRepository) {}

  execute(unreadOnly?: boolean): Promise<Notification[]> {
    return this.repo.findAll(unreadOnly);
  }
}
