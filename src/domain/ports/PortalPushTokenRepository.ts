/**
 * PortalPushTokenRepository — domain port (portal-push-notifications).
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { PortalPushToken } from '../entities/portalPush';

export interface UpsertPushTokenInput {
  accountId: string;
  token: string;
  platform: 'android' | 'ios';
  deviceLabel?: string | null;
}

/**
 * push-service-alert targeting — UNA cuenta con >=1 token vivo y
 * `serviceAlerts=true`. `tokens` trae SOLO los tokens vivos (invalidAt null)
 * de esa cuenta — nunca los invalidados (auditoría, no se reintenta contra
 * ellos).
 */
export interface PushServiceAlertTarget {
  accountId: string;
  clientId: string;
  tokens: string[];
}

export interface PortalPushTokenRepository {
  /**
   * Upsert por `token` (columna `@unique`). Si el token YA pertenece a OTRA
   * cuenta, esta llamada lo REASIGNA (accountId se pisa) — un teléfono
   * vendido/prestado no puede seguir recibiendo el push del dueño anterior.
   * Refresca `lastSeenAt` y limpia `invalidAt` (un token que vuelve a
   * registrarse está, por definición, vivo de nuevo).
   */
  upsertByToken(input: UpsertPushTokenInput): Promise<PortalPushToken>;
  /**
   * Borra el token SOLO si pertenece a `accountId` — un IDOR estructural: el
   * caller nunca puede borrar el token de otra cuenta pasando un `token`
   * ajeno. Devuelve `true` si se borró una fila, `false` en cualquier otro
   * caso (token inexistente O de otra cuenta) — mismo criterio "sin filtrar
   * cuál de los dos pasó" que el resto del portal.
   */
  deleteForAccount(accountId: string, token: string): Promise<boolean>;
  /**
   * push-service-alert — cuentas con `PortalPushPreference.serviceAlerts=true`
   * y >=1 token vivo. `clientIds` ausente/undefined = universo completo (sin
   * filtro de nodo); `[]` = ningún cliente matchea (el caller ya resolvió el
   * segmento a un conjunto vacío) — devuelve `[]` sin disparar query, mismo
   * criterio que `PortalAccountRepository.countByClientIds`.
   */
  listServiceAlertTargets(clientIds?: string[]): Promise<PushServiceAlertTarget[]>;
  /**
   * Marca `invalidAt=now()` para los tokens dados (reportados por FCM como
   * `UNREGISTERED`/`INVALID_ARGUMENT`) — NUNCA los borra (auditoría). `[]` de
   * input = no-op sin disparar query.
   */
  markInvalid(tokens: string[]): Promise<void>;
}
