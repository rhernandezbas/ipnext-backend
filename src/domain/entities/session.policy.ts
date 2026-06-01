/**
 * Session liveness policy (session-expiration).
 *
 * Centralises the single definition of an "alive" session so the middleware,
 * the active-sessions list and the history list never drift. Pure domain — no
 * external dependencies.
 *
 * A session is ALIVE when ALL of these hold (evaluated against `now`):
 *   - revokedAt IS NULL                  (not explicitly revoked)
 *   - expiresAt > now                    (absolute cap: 8h from login, == JWT MAX_AGE)
 *   - lastSeenAt > now - INACTIVITY_TTL  (inactivity cap: 1h since last activity)
 *
 * A legacy row with `expiresAt = null` (created before the column existed) is
 * treated as NOT alive — the backfill migration sets it, but defence in depth.
 */

/** Inactivity window: a session dies 1h after its last activity. */
export const INACTIVITY_TTL_MS = 60 * 60 * 1000;

/** Absolute window: a session dies 8h after login, aligned to JWT MAX_AGE_SECONDS. */
export const ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;

import type { Session } from './session';

/** True iff the session is alive at `now` (epoch ms). */
export function isSessionAlive(session: Session, now: number = Date.now()): boolean {
  if (session.revokedAt !== null) return false;

  if (session.expiresAt === null) return false;
  const expiresAt = Date.parse(session.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= now) return false;

  const lastSeenAt = Date.parse(session.lastSeenAt);
  if (Number.isNaN(lastSeenAt) || lastSeenAt <= now - INACTIVITY_TTL_MS) return false;

  return true;
}
