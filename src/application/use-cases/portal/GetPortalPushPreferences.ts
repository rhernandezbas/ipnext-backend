import type { PortalPushPreferenceRepository } from '@domain/ports/PortalPushPreferenceRepository';
import { toPortalPushPreferenceDto, type PortalPushPreferenceDto } from '@application/dto/portal/portalPush.dto';

/**
 * GetPortalPushPreferences — `GET /api/portal/push/preferences` (portal-push-notifications).
 *
 * Crea el registro con los defaults del schema (`serviceAlerts=true`,
 * `promos=false`) si la cuenta todavía no tiene uno — un cliente que nunca
 * tocó el toggle igual necesita ver un estado coherente la PRIMERA vez que
 * abre la pantalla de notificaciones.
 */
export class GetPortalPushPreferences {
  constructor(private readonly prefs: Pick<PortalPushPreferenceRepository, 'getOrCreate'>) {}

  async execute(accountId: string): Promise<PortalPushPreferenceDto> {
    const pref = await this.prefs.getOrCreate(accountId);
    return toPortalPushPreferenceDto(pref);
  }
}
