import type { PortalPushTokenRepository } from '@domain/ports/PortalPushTokenRepository';
import { toPortalPushPreferenceDto, type PortalPushPreferenceDto } from '@application/dto/portal/portalPush.dto';

/**
 * GetPortalPushPreferences — `GET /api/portal/push/preferences?token=` (push-per-device).
 *
 * push-per-device — las preferencias son POR DISPOSITIVO, no por cuenta (ver
 * el docblock de `PortalPushToken`): esta llamada YA NO usa
 * `PortalPushPreferenceRepository` (huérfano, sin lecturas — ver su
 * docblock). `token` DEBE pertenecer a `accountId` — `findForAccount` hace el
 * ownership check; si el token no existe O es de otra cuenta, devuelve
 * `null` y el caller (route) responde 404 indistinguible (anti-IDOR, mismo
 * criterio que el resto del portal).
 */
export class GetPortalPushPreferences {
  constructor(private readonly tokens: Pick<PortalPushTokenRepository, 'findForAccount'>) {}

  async execute(accountId: string, token: string): Promise<PortalPushPreferenceDto | null> {
    const row = await this.tokens.findForAccount(accountId, token);
    if (!row) return null;
    return toPortalPushPreferenceDto(row);
  }
}
