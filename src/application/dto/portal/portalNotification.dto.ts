import { z } from 'zod';
import type { PortalNotification } from '@domain/entities/portalNotification';

/**
 * DTO client-facing — deliberadamente SIN `accountId` (el cliente ya sabe
 * quién es por el token de sesión, mismo criterio que `PortalPushPreferenceDto`).
 */
export interface PortalNotificationDto {
  id: string;
  channel: 'service' | 'promo';
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  sentAt: string;
  readAt: string | null;
}

export function toPortalNotificationDto(n: PortalNotification): PortalNotificationDto {
  return {
    id: n.id,
    channel: n.channel,
    title: n.title,
    body: n.body,
    data: n.data,
    sentAt: n.sentAt,
    readAt: n.readAt,
  };
}

/**
 * `POST /api/portal/notifications/read` — validación de FORMA únicamente.
 * `[]` es válido (no-op, mismo criterio que `PortalNotificationRepository.markRead`).
 */
export const MarkPortalNotificationsReadSchema = z
  .object({
    ids: z.array(z.string().trim().min(1)),
  })
  .strict();

export type MarkPortalNotificationsReadBody = z.infer<typeof MarkPortalNotificationsReadSchema>;
