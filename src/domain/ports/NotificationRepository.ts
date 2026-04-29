import { Notification } from '@domain/entities/notification';

export interface NotificationRepository {
  findAll(unreadOnly?: boolean): Promise<Notification[]>;
  markAsRead(id: string): Promise<Notification | null>;
  markAllAsRead(): Promise<void>;
  delete(id: string): Promise<boolean>;
}
