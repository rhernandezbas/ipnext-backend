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
 * push-per-device — patch aplicado por `updatePreferences`. Mismo contrato
 * que `UpdatePortalPushPreferenceInput` (el port huérfano de
 * `PortalPushPreferenceRepository`): la decisión de negocio de "¿esto es un
 * opt-in NUEVO de promos?" vive en el USE CASE
 * (`UpdatePortalPushPreferences`), no acá — el repo solo persiste lo que se
 * le pasa. `promosOptInAt`/`promosOptInAppVersion` ausentes (undefined) = no
 * tocar esas dos columnas (preserva el histórico en el camino true->false).
 */
export interface UpdatePortalPushTokenPreferenceInput {
  serviceAlerts?: boolean;
  promos?: boolean;
  promosOptInAt?: Date;
  promosOptInAppVersion?: string | null;
}

/**
 * push-per-device — targeting de `SendPushServiceAlert`: UNA cuenta con >=1
 * token que cumple AMBAS condiciones — vivo (`invalidAt=null`) Y
 * `serviceAlerts=true` — a nivel de ESE TOKEN, no de la cuenta. `tokens` trae
 * SOLO esos tokens calificados: si la cuenta tiene 2 dispositivos y uno tiene
 * `serviceAlerts=false`, ese token NO aparece acá (el push le llega al otro
 * nomás) — el caso que motiva el change (una cuenta compartida por una
 * familia, cada teléfono decide por sí mismo).
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
   * push-service-alert — cuentas con >=1 TOKEN en `serviceAlerts=true` Y
   * `invalidAt=null` (ver el docblock de `PushServiceAlertTarget` — el filtro
   * es por dispositivo, no por cuenta). `clientIds` ausente/undefined =
   * universo completo (sin filtro de nodo); `[]` = ningún cliente matchea (el
   * caller ya resolvió el segmento a un conjunto vacío) — devuelve `[]` sin
   * disparar query, mismo criterio que `PortalAccountRepository.countByClientIds`.
   */
  listServiceAlertTargets(clientIds?: string[]): Promise<PushServiceAlertTarget[]>;
  /**
   * Marca `invalidAt=now()` para los tokens dados (reportados por FCM como
   * `UNREGISTERED`/`INVALID_ARGUMENT`) — NUNCA los borra (auditoría). `[]` de
   * input = no-op sin disparar query.
   */
  markInvalid(tokens: string[]): Promise<void>;
  /**
   * push-per-device — `GET /api/portal/push/preferences?token=`. Busca el
   * token DENTRO de `accountId` — ownership check estructural. Si el token no
   * existe, O existe pero pertenece a OTRA cuenta, devuelve `null` (mismo
   * criterio 404 indistinguible que el resto del portal — ver
   * `deleteForAccount`, nunca se filtra cuál de los dos pasó).
   */
  findForAccount(accountId: string, token: string): Promise<PortalPushToken | null>;
  /**
   * push-per-device — `PUT /api/portal/push/preferences`. Update PARCIAL de
   * las preferencias de push de UN dispositivo — mismo ownership check que
   * `findForAccount`/`deleteForAccount`: si el token no pertenece a
   * `accountId`, devuelve `null` SIN tocar nada (nunca lanza, nunca escribe
   * la fila de otra cuenta).
   */
  updatePreferences(
    accountId: string,
    token: string,
    patch: UpdatePortalPushTokenPreferenceInput,
  ): Promise<PortalPushToken | null>;
}
