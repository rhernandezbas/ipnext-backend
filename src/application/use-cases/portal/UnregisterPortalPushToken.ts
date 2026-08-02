import type { PortalPushTokenRepository } from '@domain/ports/PortalPushTokenRepository';

/**
 * UnregisterPortalPushToken — `DELETE /api/portal/push/register` (portal-push-notifications).
 *
 * Borra el token SOLO si pertenece a `accountId` (el token de sesión) — el
 * repo ya hace el chequeo de pertenencia (IDOR estructural); este use case
 * solo lo reenvía. El caller (route) responde 204 SIEMPRE, exista o no el
 * token — mismo criterio anti-enumeración que `LogoutPortal`.
 */
export class UnregisterPortalPushToken {
  constructor(private readonly tokens: Pick<PortalPushTokenRepository, 'deleteForAccount'>) {}

  async execute(accountId: string, token: string): Promise<boolean> {
    return this.tokens.deleteForAccount(accountId, token);
  }
}
