import jwt from 'jsonwebtoken';
import type { PortalTokenService, PortalAccessTokenClaims } from '@domain/ports/PortalTokenService';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // portal-auth spec: "expiración <= 15 minutos"
const AUDIENCE = 'portal';

interface PortalJwtPayload {
  sub: string;
  clientId: string;
  aud: string;
}

/**
 * JwtPortalTokenService — production adapter for PortalTokenService.
 *
 * Same secret as the admin `JwtAuthAdapter` (design.md §3: "Mismo secret ...
 * la separación es el aud") — a single JWT_SECRET rotation covers both universes.
 * Mirrors JwtAuthAdapter's constructor contract: an explicit `secret` (tests) or a
 * lazy `config.jwtSecret` read (production, avoids config.ts's fail-fast validateEnv
 * running in test environments that don't set every required env var).
 */
export class JwtPortalTokenService implements PortalTokenService {
  private readonly secret: string;

  constructor(secret?: string) {
    if (secret !== undefined) {
      this.secret = secret;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { config } = require('../../config') as { config: { jwtSecret: string } };
      this.secret = config.jwtSecret;
    }
  }

  signAccessToken(claims: PortalAccessTokenClaims): string {
    const payload: Omit<PortalJwtPayload, 'aud'> = {
      sub: claims.accountId,
      clientId: claims.clientId,
    };
    return jwt.sign(payload, this.secret, { expiresIn: ACCESS_TOKEN_TTL_SECONDS, audience: AUDIENCE });
  }

  verifyAccessToken(token: string): PortalAccessTokenClaims | null {
    try {
      // L4 (fix wave) — defensa en profundidad: algoritmo PINEADO. Sin esto,
      // jsonwebtoken acepta cualquier HS* (p.ej. HS512 con el mismo secret);
      // el pin elimina de raiz toda clase de confusion de algoritmo.
      const decoded = jwt.verify(token, this.secret, { audience: AUDIENCE, algorithms: ['HS256'] }) as PortalJwtPayload;
      if (typeof decoded.sub !== 'string' || typeof decoded.clientId !== 'string') return null;
      return { accountId: decoded.sub, clientId: decoded.clientId };
    } catch {
      return null;
    }
  }
}
