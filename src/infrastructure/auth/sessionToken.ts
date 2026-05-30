import { createHash } from 'crypto';

/**
 * Hash a JWT into the value stored as Session.tokenHash. The raw token is never
 * persisted — only this sha256 digest. Used by login (create), the auth
 * middleware (revocation check) and logout (revoke current).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
