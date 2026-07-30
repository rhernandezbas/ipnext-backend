/**
 * PortalSession liveness/reuse policy (customer-portal-api, portal-auth spec
 * "Refresh rotativo y logout"). Centralises the single definition so
 * `RefreshPortalSession` never drifts from what a test asserts. Pure domain — no
 * external dependencies.
 */
import type { PortalSession } from './portalSession';

/** True when this refresh was already exchanged once — reuse = theft signal. */
export function isPortalSessionReused(session: PortalSession): boolean {
  return session.rotatedAt !== null;
}

export function isPortalSessionRevoked(session: PortalSession): boolean {
  return session.revokedAt !== null;
}

/** True iff `expiresAt` is at or before `now` (epoch ms). */
export function isPortalSessionExpired(session: PortalSession, now: number = Date.now()): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt <= now;
}

/** True iff the session can be exchanged for a new pair right now. */
export function isPortalSessionUsable(session: PortalSession, now: number = Date.now()): boolean {
  if (isPortalSessionReused(session)) return false;
  if (isPortalSessionRevoked(session)) return false;
  if (isPortalSessionExpired(session, now)) return false;
  return true;
}
