import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import type { PortalPushTokenRepository } from '@domain/ports/PortalPushTokenRepository';
import { hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

/**
 * LogoutPortal — customer-portal-api (Fase 2, task 2.3).
 *
 * portal-auth spec "Refresh rotativo y logout": revokes the session tied to the
 * presented refresh token. Idempotent and silent on an unknown/already-revoked
 * token — same anti-enumeration posture as login, logout must never tell a caller
 * whether a given refresh token ever existed.
 *
 * portal-push-notifications — baja del token de push DEL DISPOSITIVO que
 * cierra sesión (proposal §2 "baja al cerrar sesión"). `LogoutPortal` no
 * conoce ningún identificador de dispositivo por sí mismo (el refresh token
 * no lo trae) — por eso `pushToken` es un parámetro OPCIONAL que la app envía
 * junto al logout cuando quiere desregistrar SU propio token en el mismo
 * viaje (evita 2 requests separados). Deliberadamente NO revoca TODOS los
 * tokens de la cuenta — un cliente con 2 dispositivos que cierra sesión en
 * uno no debe perder los avisos de servicio en el otro. `pushTokens` es
 * OPCIONAL (back-compat con callers/tests que wireaban `LogoutPortal` antes
 * de esta feature, mismo criterio que los deps opcionales de
 * `PortalRouterDeps`) — sin esa dependencia, `pushToken` se ignora
 * silenciosamente. Falla best-effort (nunca tumba el logout): revocar la
 * sesión es la parte que IMPORTA.
 */
export class LogoutPortal {
  constructor(
    private readonly sessions: PortalSessionRepository,
    private readonly pushTokens?: Pick<PortalPushTokenRepository, 'deleteForAccount'>,
  ) {}

  async execute(refreshToken: string, pushToken?: string): Promise<void> {
    const session = await this.sessions.findByTokenHash(hashPortalRefreshToken(refreshToken));
    if (session && session.revokedAt === null) {
      await this.sessions.revoke(session.id);
      if (pushToken && this.pushTokens) {
        try {
          await this.pushTokens.deleteForAccount(session.accountId, pushToken);
        } catch {
          // best-effort — un fallo acá NUNCA debe hacer parecer que el logout falló.
        }
      }
    }
  }
}
