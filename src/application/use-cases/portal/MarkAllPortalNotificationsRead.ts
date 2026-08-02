import type { PortalNotificationRepository } from '@domain/ports/PortalNotificationRepository';

/**
 * MarkAllPortalNotificationsRead — portal-notification-inbox,
 * `POST /api/portal/notifications/read-all`. Marca TODAS las no-leídas de
 * `accountId` (y solo las de esa cuenta).
 */
export class MarkAllPortalNotificationsRead {
  constructor(private readonly notifications: Pick<PortalNotificationRepository, 'markAllRead'>) {}

  async execute(accountId: string): Promise<void> {
    await this.notifications.markAllRead(accountId);
  }
}
