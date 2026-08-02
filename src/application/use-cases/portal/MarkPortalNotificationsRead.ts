import type { PortalNotificationRepository } from '@domain/ports/PortalNotificationRepository';

/**
 * MarkPortalNotificationsRead — portal-notification-inbox,
 * `POST /api/portal/notifications/read`. `ids` ajenos a `accountId` se
 * ignoran EN SILENCIO (el repo hace el filtro real) — ni error ni efecto.
 */
export class MarkPortalNotificationsRead {
  constructor(private readonly notifications: Pick<PortalNotificationRepository, 'markRead'>) {}

  async execute(accountId: string, ids: string[]): Promise<void> {
    await this.notifications.markRead(accountId, ids);
  }
}
