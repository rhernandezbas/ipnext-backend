import { NotificationRepository } from '@domain/ports/NotificationRepository';

export class DeleteNotification {
  constructor(private readonly repo: NotificationRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
