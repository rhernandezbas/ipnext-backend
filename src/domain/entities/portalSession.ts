/**
 * PortalSession domain entity — customer-portal-api (Fase 1).
 *
 * A rotating opaque refresh token tied to a PortalAccount. `tokenHash` is sha256 of
 * the raw refresh token (32 random bytes, base64url) — the raw token is NEVER
 * persisted, same convention as the admin `Session.tokenHash`.
 *
 * `rotatedAt` marks "this refresh was already exchanged for a new pair" — a session
 * is single-use. A second exchange attempt against an already-rotated session is the
 * theft signal that makes `RefreshPortalSession` revoke every session of the account
 * (see `portalSession.policy.ts`).
 *
 * Pure domain — zero external dependencies.
 */
export interface PortalSession {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
}
