import type { PortalNotificationRepository } from '@domain/ports/PortalNotificationRepository';
import type { PaginatedQuery } from '@domain/entities/pagination';
import type { PortalNotificationDto } from '@application/dto/portal/portalNotification.dto';
import { toPortalNotificationDto } from '@application/dto/portal/portalNotification.dto';

export interface ListPortalNotificationsResult {
  data: PortalNotificationDto[];
  /** Total de no-leídas de LA CUENTA, no de esta página — ver el docblock del port. */
  unread: number;
}

/**
 * ListPortalNotifications — portal-notification-inbox, `GET /api/portal/notifications`.
 *
 * `accountId` sale SIEMPRE del token de sesión (anti-IDOR estructural, mismo
 * criterio que el resto del portal) — este use case nunca recibe un
 * `accountId` que el caller pueda manipular.
 */
export class ListPortalNotifications {
  constructor(private readonly notifications: Pick<PortalNotificationRepository, 'listForAccount' | 'countUnread'>) {}

  async execute(accountId: string, query: PaginatedQuery): Promise<ListPortalNotificationsResult> {
    const [page, unread] = await Promise.all([
      this.notifications.listForAccount(accountId, query),
      this.notifications.countUnread(accountId),
    ]);
    return { data: page.data.map(toPortalNotificationDto), unread };
  }
}
