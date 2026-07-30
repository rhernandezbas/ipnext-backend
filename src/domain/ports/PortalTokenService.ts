/**
 * PortalTokenService — domain port (customer-portal-api Fase 2).
 *
 * Abstracts signing/verifying the portal access JWT (`aud=portal`) so use cases
 * (`PortalLogin`, `RefreshPortalSession`) never import `jsonwebtoken` directly —
 * same DIP boundary as `AuthProvider`/`JwtAuthAdapter` for the admin JWT.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or jsonwebtoken.
 */
export interface PortalAccessTokenClaims {
  accountId: string;
  clientId: string;
}

export interface PortalTokenService {
  /** Signs a short-lived (<=15min) access token with `aud=portal`. */
  signAccessToken(claims: PortalAccessTokenClaims): string;
  /**
   * Verifies the token and returns its claims, or `null` when the token is
   * invalid, expired, or missing/wrong `aud` (never throws — callers 401 on null).
   */
  verifyAccessToken(token: string): PortalAccessTokenClaims | null;
}
