/**
 * Session domain entity.
 *
 * A login session tied to an RbacUser. `tokenHash` is sha256 of the JWT (the
 * raw token is never stored). `actorLogin` is a snapshot taken at login so the
 * sessions list needs no join back to RbacUser.
 *
 * Liveness (session-expiration): a session is "alive" when `revokedAt` is null
 * AND `expiresAt` is in the future (absolute 8h cap, aligned to JWT MAX_AGE) AND
 * `lastSeenAt` is within the inactivity window (1h). See `session.policy.ts`.
 * `expiresAt` is nullable only for legacy rows predating the column; such rows
 * are treated as expired.
 *
 * Pure domain — zero external dependencies.
 */
export interface Session {
  id: string;
  rbacUserId: string;
  actorLogin: string;
  tokenHash: string;
  ip: string | null;
  userAgent: string | null;
  loginAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}
