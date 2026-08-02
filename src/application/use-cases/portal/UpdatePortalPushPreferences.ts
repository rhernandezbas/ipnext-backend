import type { PortalPushPreferenceRepository } from '@domain/ports/PortalPushPreferenceRepository';
import { toPortalPushPreferenceDto, type PortalPushPreferenceDto } from '@application/dto/portal/portalPush.dto';

export interface UpdatePortalPushPreferencesInput {
  serviceAlerts?: boolean;
  promos?: boolean;
}

/**
 * UpdatePortalPushPreferences — `PUT /api/portal/push/preferences` (portal-push-notifications).
 *
 * `promos` false->true: estampa `promosOptInAt`/`promosOptInAppVersion` — el
 * rastro auditable del consentimiento explícito de marketing (Apple 4.5.4 /
 * Ley 25.326 art. 27). `promos` true->false (o ausente): el histórico del
 * opt-in NO se toca — apagar promos no borra evidencia de que en algún
 * momento se aceptó. La decisión de "¿esto es un opt-in NUEVO?" vive ACÁ (se
 * necesita el valor ANTERIOR, que solo el use case puede leer vía
 * `getOrCreate` antes de escribir) — el repo solo persiste lo que se le pasa.
 *
 * `appVersion`: `X-App-Version` del request, o `null` si el header no vino —
 * mismo criterio "mejor esfuerzo, nunca bloquea" que el resto del portal.
 */
export class UpdatePortalPushPreferences {
  constructor(
    private readonly prefs: Pick<PortalPushPreferenceRepository, 'getOrCreate' | 'update'>,
    /** Clock seam for deterministic tests (mirror DeleteMyPortalAccount/PortalLogin). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    accountId: string,
    patch: UpdatePortalPushPreferencesInput,
    appVersion: string | null,
  ): Promise<PortalPushPreferenceDto> {
    const current = await this.prefs.getOrCreate(accountId);

    const repoPatch: Parameters<PortalPushPreferenceRepository['update']>[1] = {};
    if (patch.serviceAlerts !== undefined) {
      repoPatch.serviceAlerts = patch.serviceAlerts;
    }
    if (patch.promos !== undefined) {
      repoPatch.promos = patch.promos;
      const isNewOptIn = patch.promos === true && current.promos === false;
      if (isNewOptIn) {
        repoPatch.promosOptInAt = this.now();
        repoPatch.promosOptInAppVersion = appVersion;
      }
      // true->false (o true->true, no-op real): promosOptInAt/AppVersion NO
      // se tocan — el histórico del opt-in original queda intacto.
    }

    const updated = await this.prefs.update(accountId, repoPatch);
    return toPortalPushPreferenceDto(updated);
  }
}
