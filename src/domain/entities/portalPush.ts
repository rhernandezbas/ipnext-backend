/**
 * portal-push-notifications / push-per-device — entidades de dominio.
 *
 * `PortalPushToken` — un dispositivo (token de registro FCM) de una cuenta del
 * portal. `invalidAt` NUNCA borra la fila (auditoría): un token que FCM
 * reporta `UNREGISTERED`/`INVALID_ARGUMENT` se marca, no se elimina.
 *
 * push-per-device — las preferencias (`serviceAlerts`/`promos`) viven ACÁ, en
 * el TOKEN, no en la cuenta. Una cuenta del portal = un contrato = una CASA:
 * marido, mujer, hijos, varios teléfonos con la MISMA cuenta. Con la
 * preferencia por cuenta, uno apaga las promos y se las apaga a TODOS; peor,
 * uno acepta marketing y el otro —que nunca consintió— empieza a recibirlo.
 * El APARATO se parece más a la persona que la cuenta en una cuenta
 * compartida. `serviceAlerts` default `true` (transaccional, sin restricción
 * de las stores). `promos` default `false` — el opt-in de marketing es
 * EXPLÍCITO (Apple 4.5.4 / Ley 25.326 art. 27), nunca asumido.
 * `promosOptInAt`/`promosOptInAppVersion` quedan SIEMPRE que el dispositivo
 * aceptó promos alguna vez, incluso si después las apaga — es el rastro
 * auditable, no el estado actual del toggle. Un re-registro del MISMO token
 * (`upsertByToken`) NUNCA resetea estas 4 columnas — solo se tocan por el
 * PUT explícito de preferencias.
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
  serviceAlerts: boolean;
  promos: boolean;
  promosOptInAt: string | null;
  promosOptInAppVersion: string | null;
}

/**
 * @deprecated push-per-device — la preferencia se mudó a `PortalPushToken`
 * (ver arriba). Esta tabla/entidad queda HUÉRFANA a propósito (sin lecturas
 * en el código: `GetPortalPushPreferences`/`UpdatePortalPushPreferences` ya
 * no la usan) — borrarla es una migración DESTRUCTIVA aparte, fuera de este
 * change. `PrismaPortalPushPreferenceRepository`/
 * `InMemoryPortalPushPreferenceRepository` siguen existiendo (implementan el
 * port) pero nada los invoca.
 */
export interface PortalPushPreference {
  id: string;
  accountId: string;
  serviceAlerts: boolean;
  promos: boolean;
  promosOptInAt: string | null;
  promosOptInAppVersion: string | null;
  updatedAt: string;
}
