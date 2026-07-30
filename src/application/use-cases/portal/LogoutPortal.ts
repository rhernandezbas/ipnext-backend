import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import { hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

/**
 * LogoutPortal — customer-portal-api (Fase 2, task 2.3).
 *
 * portal-auth spec "Refresh rotativo y logout": revokes the session tied to the
 * presented refresh token. Idempotent and silent on an unknown/already-revoked
 * token — same anti-enumeration posture as login, logout must never tell a caller
 * whether a given refresh token ever existed.
 */
export class LogoutPortal {
  constructor(private readonly sessions: PortalSessionRepository) {}

  async execute(refreshToken: string): Promise<void> {
    const session = await this.sessions.findByTokenHash(hashPortalRefreshToken(refreshToken));
    if (session && session.revokedAt === null) {
      await this.sessions.revoke(session.id);
    }
  }
}
