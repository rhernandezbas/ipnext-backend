import { NotificationRepository } from '@domain/ports/NotificationRepository';

export class MarkAllNotificationsRead {
  constructor(private readonly repo: NotificationRepository) {}

  execute(): Promise<void> {
    return this.repo.markAllAsRead();
  }
}
