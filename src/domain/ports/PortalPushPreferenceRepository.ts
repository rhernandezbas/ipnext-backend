/**
 * PortalPushPreferenceRepository — domain port (portal-push-notifications).
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { PortalPushPreference } from '../entities/portalPush';

/**
 * Patch aplicado por `update`. La decisión de negocio (¿esto es un opt-in
 * NUEVO de promos que hay que estampar?) vive en el USE CASE
 * (`UpdatePortalPushPreferences`), no acá — el repo solo persiste lo que se
 * le pasa. `promosOptInAt`/`promosOptInAppVersion` viajan explícitos cuando
 * el use case decide estampar un opt-in nuevo; ausentes (undefined) = no
 * tocar esas dos columnas (preserva el histórico en el camino true->false).
 */
export interface UpdatePortalPushPreferenceInput {
  serviceAlerts?: boolean;
  promos?: boolean;
  promosOptInAt?: Date;
  promosOptInAppVersion?: string | null;
}

export interface PortalPushPreferenceRepository {
  /**
   * Devuelve la preferencia de la cuenta; si no existe, la CREA con los
   * defaults del schema (`serviceAlerts=true`, `promos=false`) — atómico
   * (upsert), nunca una carrera read-then-create.
   */
  getOrCreate(accountId: string): Promise<PortalPushPreference>;
  /**
   * Update parcial — solo las keys presentes en `patch` cambian. Si la fila
   * no existe todavía (PUT antes de un GET previo), la crea con los defaults
   * + el patch aplicado (mismo comportamiento atómico que `getOrCreate`).
   */
  update(accountId: string, patch: UpdatePortalPushPreferenceInput): Promise<PortalPushPreference>;
}
