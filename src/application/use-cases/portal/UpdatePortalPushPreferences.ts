import type { PortalPushTokenRepository, UpdatePortalPushTokenPreferenceInput } from '@domain/ports/PortalPushTokenRepository';
import { toPortalPushPreferenceDto, type PortalPushPreferenceDto } from '@application/dto/portal/portalPush.dto';

export interface UpdatePortalPushPreferencesInput {
  token: string;
  serviceAlerts?: boolean;
  promos?: boolean;
}

/**
 * UpdatePortalPushPreferences — `PUT /api/portal/push/preferences` (push-per-device).
 *
 * push-per-device — patchea las preferencias de UN token, no de la cuenta
 * (ver el docblock de `PortalPushToken`). `token` DEBE pertenecer a
 * `accountId`: se verifica con `findForAccount` ANTES de escribir — si no
 * pertenece (o no existe), devuelve `null` sin tocar nada y el caller (route)
 * responde 404 indistinguible.
 *
 * `promos` false->true: estampa `promosOptInAt`/`promosOptInAppVersion` — el
 * rastro auditable del consentimiento explícito de marketing de ESE
 * dispositivo (Apple 4.5.4 / Ley 25.326 art. 27). `promos` true->false (o
 * ausente): el histórico del opt-in NO se toca — apagar promos no borra
 * evidencia de que en algún momento se aceptó. La decisión de "¿esto es un
 * opt-in NUEVO?" vive ACÁ (se necesita el valor ANTERIOR del token, que solo
 * el use case puede leer vía `findForAccount` antes de escribir) — el repo
 * solo persiste lo que se le pasa.
 *
 * `appVersion`: `X-App-Version` del request, o `null` si el header no vino —
 * mismo criterio "mejor esfuerzo, nunca bloquea" que el resto del portal.
 */
export class UpdatePortalPushPreferences {
  constructor(
    private readonly tokens: Pick<PortalPushTokenRepository, 'findForAccount' | 'updatePreferences'>,
    /** Clock seam for deterministic tests (mirror DeleteMyPortalAccount/PortalLogin). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    accountId: string,
    patch: UpdatePortalPushPreferencesInput,
    appVersion: string | null,
  ): Promise<PortalPushPreferenceDto | null> {
    const current = await this.tokens.findForAccount(accountId, patch.token);
    if (!current) return null;

    const repoPatch: UpdatePortalPushTokenPreferenceInput = {};
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

    const updated = await this.tokens.updatePreferences(accountId, patch.token, repoPatch);
    // Defensivo — ownership ya se confirmó arriba; solo puede dar null por una
    // carrera (el token se borró entre el find y el update). Mismo 404 que
    // "nunca perteneció".
    if (!updated) return null;
    return toPortalPushPreferenceDto(updated);
  }
}
