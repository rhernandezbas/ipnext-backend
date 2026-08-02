import type { PortalNotificationRepository } from '@domain/ports/PortalNotificationRepository';

export interface PortalNotificationsUnreadCountResult {
  unread: number;
}

/**
 * GetPortalNotificationsUnreadCount — portal-notification-inbox,
 * `GET /api/portal/notifications/unread-count`. Barato a propósito (una sola
 * `COUNT`) — la app lo pollea para el badge del buzón.
 */
export class GetPortalNotificationsUnreadCount {
  constructor(private readonly notifications: Pick<PortalNotificationRepository, 'countUnread'>) {}

  async execute(accountId: string): Promise<PortalNotificationsUnreadCountResult> {
    const unread = await this.notifications.countUnread(accountId);
    return { unread };
  }
}
