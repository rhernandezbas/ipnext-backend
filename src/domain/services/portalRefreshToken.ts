/**
 * portalRefreshToken — customer-portal-api (Fase 2, task 2.2/2.3).
 *
 * The opaque refresh token issued alongside the portal access JWT. 32 random bytes,
 * base64url-encoded (design.md §3) — never persisted raw, only its sha256 digest
 * (`hashPortalRefreshToken`, stored as `PortalSession.tokenHash`). Same "hash before
 * persisting" convention as the admin session's `hashToken` (sessionToken.ts), kept
 * here in the domain layer (not infrastructure) because `PortalLogin`/
 * `RefreshPortalSession` generate and hash the token THEMSELVES (unlike the admin
 * flow, where session creation happens in the route) — `crypto` is Node core, not a
 * framework dependency, same precedent as `generatePortalPassword`.
 */
import { randomBytes, createHash } from 'crypto';

const REFRESH_TOKEN_BYTES = 32;

export function generatePortalRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashPortalRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
