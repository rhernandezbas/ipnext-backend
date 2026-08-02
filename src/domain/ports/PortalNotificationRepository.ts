/**
 * PortalNotificationRepository — domain port (portal-notification-inbox).
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { PortalNotification } from '../entities/portalNotification';
import type { PaginatedResult, PaginatedQuery } from '../entities/pagination';

export interface CreatePortalNotificationInput {
  accountId: string;
  channel: 'service' | 'promo';
  title: string;
  body: string;
  /** El mismo payload `data` del push (deep link) — ausente/null = sin deep link. */
  data?: Record<string, unknown> | null;
}

export interface PortalNotificationRepository {
  /**
   * 1 fila por cuenta destinataria — ver `SendPushServiceAlert`. El caller es
   * responsable de que una falla de ESTE insert nunca tumbe el envío del push
   * (log + sigue, no se propaga como excepción fatal del flujo de envío).
   */
  create(input: CreatePortalNotificationInput): Promise<PortalNotification>;
  /**
   * Paginado, `sentAt desc`, SOLO de `accountId` — anti-IDOR estructural, el
   * caller nunca pasa un `accountId` ajeno (siempre sale del token de sesión).
   * page=1/limit=25 cuando omitidos/inválidos, mismo contrato que el resto de
   * `PaginatedQuery` del portal.
   */
  listForAccount(accountId: string, query: PaginatedQuery): Promise<PaginatedResult<PortalNotification>>;
  /** Total de no-leídas de LA CUENTA (no de una página) — badge + envelope de `GET /notifications`. */
  countUnread(accountId: string): Promise<number>;
  /**
   * Marca `readAt=now()` únicamente en las filas de `accountId` cuyo `id` está
   * en `ids` — un id ajeno en el array se ignora EN SILENCIO (ni error ni
   * efecto, mismo criterio IDOR que `PortalPushTokenRepository.deleteForAccount`).
   * `[]` de input = no-op sin disparar query.
   */
  markRead(accountId: string, ids: string[]): Promise<void>;
  /** Marca TODAS las no-leídas de `accountId` (y solo las de esa cuenta) como leídas. */
  markAllRead(accountId: string): Promise<void>;
}
