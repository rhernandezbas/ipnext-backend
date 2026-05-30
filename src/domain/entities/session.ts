/**
 * Session domain entity.
 *
 * A login session tied to an RbacUser. `tokenHash` is sha256 of the JWT (the
 * raw token is never stored). `actorLogin` is a snapshot taken at login so the
 * sessions list needs no join back to RbacUser. `revokedAt = null` ⇒ active.
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
  createdAt: string;
}
