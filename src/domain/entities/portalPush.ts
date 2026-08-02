/**
 * portal-push-notifications — entidades de dominio.
 *
 * `PortalPushToken` — un dispositivo (token de registro FCM) de una cuenta del
 * portal. `invalidAt` NUNCA borra la fila (auditoría): un token que FCM
 * reporta `UNREGISTERED`/`INVALID_ARGUMENT` se marca, no se elimina.
 *
 * `PortalPushPreference` — 1 fila por cuenta (única). `serviceAlerts` default
 * `true` (transaccional, sin restricción de las stores). `promos` default
 * `false` — el opt-in de marketing es EXPLÍCITO (Apple 4.5.4 / Ley 25.326
 * art. 27), nunca asumido. `promosOptInAt`/`promosOptInAppVersion` quedan
 * SIEMPRE que el cliente aceptó promos alguna vez, incluso si después las
 * apaga — es el rastro auditable, no el estado actual del toggle.
 */
export interface PortalPushToken {
  id: string;
  accountId: string;
  token: string;
  platform: 'android' | 'ios';
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  invalidAt: string | null;
}

export interface PortalPushPreference {
  id: string;
  accountId: string;
  serviceAlerts: boolean;
  promos: boolean;
  promosOptInAt: string | null;
  promosOptInAppVersion: string | null;
  updatedAt: string;
}
