/**
 * Session liveness policy (session-expiration).
 *
 * A session is "alive" when ALL hold:
 *   - revokedAt IS NULL
 *   - expiresAt > now            (absolute 8h cap, aligned to JWT MAX_AGE)
 *   - lastSeenAt > now - 1h      (inactivity TTL)
 */
import {
  isSessionAlive,
  INACTIVITY_TTL_MS,
  ABSOLUTE_TTL_MS,
} from '@domain/entities/session.policy';
import type { Session } from '@domain/entities/session';

const NOW = Date.parse('2026-05-31T12:00:00.000Z');

function session(partial: Partial<Session>): Session {
  const loginAt = partial.loginAt ?? new Date(NOW).toISOString();
  return {
    id: 's1',
    rbacUserId: 'u1',
    actorLogin: 'ana',
    tokenHash: 'h1',
    ip: null,
    userAgent: null,
    loginAt,
    lastSeenAt: partial.lastSeenAt ?? loginAt,
    revokedAt: partial.revokedAt ?? null,
    expiresAt: partial.expiresAt ?? new Date(Date.parse(loginAt) + ABSOLUTE_TTL_MS).toISOString(),
    createdAt: loginAt,
  };
}

describe('session policy constants', () => {
  it('inactivity TTL is 1 hour and absolute TTL is 8 hours', () => {
    expect(INACTIVITY_TTL_MS).toBe(60 * 60 * 1000);
    expect(ABSOLUTE_TTL_MS).toBe(8 * 60 * 60 * 1000);
  });
});

describe('isSessionAlive', () => {
  it('a fresh session (just logged in, just seen) is alive', () => {
    const s = session({ loginAt: new Date(NOW).toISOString() });
    expect(isSessionAlive(s, NOW)).toBe(true);
  });

  it('a revoked session is NOT alive', () => {
    const s = session({ revokedAt: new Date(NOW - 1000).toISOString() });
    expect(isSessionAlive(s, NOW)).toBe(false);
  });

  it('an inactive session (lastSeenAt older than 1h) is NOT alive', () => {
    const s = session({
      loginAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2h ago, still under absolute
      lastSeenAt: new Date(NOW - 61 * 60 * 1000).toISOString(), // 61 min ago
    });
    expect(isSessionAlive(s, NOW)).toBe(false);
  });

  it('a session active within the last hour is alive', () => {
    const s = session({
      loginAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
      lastSeenAt: new Date(NOW - 59 * 60 * 1000).toISOString(), // 59 min ago
    });
    expect(isSessionAlive(s, NOW)).toBe(true);
  });

  it('a session past its absolute 8h cap is NOT alive even if recently seen', () => {
    const s = session({
      loginAt: new Date(NOW - 9 * 60 * 60 * 1000).toISOString(), // 9h ago
      lastSeenAt: new Date(NOW - 60 * 1000).toISOString(), // seen 1 min ago
      expiresAt: new Date(NOW - 60 * 60 * 1000).toISOString(), // expired 1h ago
    });
    expect(isSessionAlive(s, NOW)).toBe(false);
  });

  it('handles a session with null expiresAt (legacy) as NOT alive on absolute cap', () => {
    const s = session({ loginAt: new Date(NOW).toISOString() });
    (s as { expiresAt: string | null }).expiresAt = null;
    expect(isSessionAlive(s, NOW)).toBe(false);
  });
});
