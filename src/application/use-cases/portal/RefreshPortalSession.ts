import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import type { PortalTokenService } from '@domain/ports/PortalTokenService';
import { InvalidPortalRefreshTokenError, PortalRefreshTokenReusedError } from '@domain/errors/portal.errors';
import { generatePortalRefreshToken, hashPortalRefreshToken } from '@domain/services/portalRefreshToken';
import {
  isPortalSessionReused,
  isPortalSessionRevoked,
  isPortalSessionExpired,
} from '@domain/entities/portalSession.policy';
import { PORTAL_REFRESH_TOKEN_TTL_MS } from './PortalLogin';

export interface RefreshPortalSessionResult {
  accessToken: string;
  refreshToken: string;
}

/**
 * RefreshPortalSession — customer-portal-api (Fase 2, task 2.3).
 *
 * portal-auth spec "Refresh rotativo y logout" + "Refresh reusado": strict
 * single-use rotation. The presented refresh token is looked up in WHATEVER state
 * it's in (see `PortalSessionRepository.findByTokenHash`) so reuse of an
 * ALREADY-rotated token can be told apart from "never existed" / "expired" /
 * "explicitly revoked" — reuse is the one case that revokes EVERY session of the
 * account (theft signal), the others just 401 on this one attempt.
 */
export class RefreshPortalSession {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly sessions: PortalSessionRepository,
    private readonly tokenService: PortalTokenService,
    /** Clock seam for deterministic tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(refreshToken: string): Promise<RefreshPortalSessionResult> {
    const tokenHash = hashPortalRefreshToken(refreshToken);
    const session = await this.sessions.findByTokenHash(tokenHash);
    if (!session) {
      throw new InvalidPortalRefreshTokenError();
    }

    if (isPortalSessionReused(session)) {
      // Theft signal: someone is replaying a refresh token that was already
      // exchanged for a newer one. Kill every session of the account — the
      // legit rotated chain dies alongside the stolen one (spec.md: "TODAS las
      // sesiones de esa cuenta se revocan").
      await this.sessions.revokeAllForAccount(session.accountId);
      throw new PortalRefreshTokenReusedError();
    }

    const now = this.now();
    if (isPortalSessionRevoked(session) || isPortalSessionExpired(session, now.getTime())) {
      throw new InvalidPortalRefreshTokenError();
    }

    const account = await this.accounts.findById(session.accountId);
    if (!account || account.status !== 'active') {
      throw new InvalidPortalRefreshTokenError();
    }

    // Rotate: the presented token is now spent, a brand-new pair replaces it.
    await this.sessions.markRotated(session.id);
    const newRefreshToken = generatePortalRefreshToken();
    await this.sessions.create({
      accountId: account.id,
      tokenHash: hashPortalRefreshToken(newRefreshToken),
      expiresAt: new Date(now.getTime() + PORTAL_REFRESH_TOKEN_TTL_MS),
    });

    const accessToken = this.tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });

    return { accessToken, refreshToken: newRefreshToken };
  }
}
