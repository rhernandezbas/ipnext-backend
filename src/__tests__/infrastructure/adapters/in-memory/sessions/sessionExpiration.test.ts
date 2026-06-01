/**
 * session-expiration — InMemorySessionRepository liveness behaviour.
 *
 * listActive must exclude expired/inactive sessions; findRevoked must include
 * them alongside revoked ones; create must stamp expiresAt = loginAt + 8h.
 */
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { ABSOLUTE_TTL_MS, INACTIVITY_TTL_MS } from '@domain/entities/session.policy';

const HOUR = 60 * 60 * 1000;

describe('InMemorySessionRepository — expiration', () => {
  it('create stamps expiresAt = loginAt + 8h', async () => {
    const repo = new InMemorySessionRepository();
    const s = await repo.create({
      rbacUserId: 'u1', actorLogin: 'ana', tokenHash: 'h1', ip: null, userAgent: null,
    });
    expect(s.expiresAt).not.toBeNull();
    const delta = Date.parse(s.expiresAt as string) - Date.parse(s.loginAt);
    expect(delta).toBe(ABSOLUTE_TTL_MS);
  });

  it('listActive excludes a session idle for more than 1h', async () => {
    const repo = new InMemorySessionRepository();
    const now = Date.now();
    repo.seed({
      tokenHash: 'idle',
      loginAt: new Date(now - 2 * HOUR).toISOString(),
      lastSeenAt: new Date(now - (INACTIVITY_TTL_MS + 60_000)).toISOString(),
      expiresAt: new Date(now + 6 * HOUR).toISOString(),
    });
    const page = await repo.listActive({ page: 1, pageSize: 10 });
    expect(page.total).toBe(0);
  });

  it('listActive excludes a session past its 8h absolute cap', async () => {
    const repo = new InMemorySessionRepository();
    const now = Date.now();
    repo.seed({
      tokenHash: 'old',
      loginAt: new Date(now - 9 * HOUR).toISOString(),
      lastSeenAt: new Date(now - 60_000).toISOString(), // recently seen
      expiresAt: new Date(now - HOUR).toISOString(), // expired
    });
    const page = await repo.listActive({ page: 1, pageSize: 10 });
    expect(page.total).toBe(0);
  });

  it('listActive includes a fresh, recently-seen session', async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ rbacUserId: 'u1', actorLogin: 'ana', tokenHash: 'fresh', ip: null, userAgent: null });
    const page = await repo.listActive({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
  });

  it('findByTokenHash returns null for an expired session', async () => {
    const repo = new InMemorySessionRepository();
    const now = Date.now();
    repo.seed({
      tokenHash: 'gone',
      loginAt: new Date(now - 9 * HOUR).toISOString(),
      expiresAt: new Date(now - HOUR).toISOString(),
    });
    expect(await repo.findByTokenHash('gone')).toBeNull();
  });

  it('findByTokenHash returns null for an idle session', async () => {
    const repo = new InMemorySessionRepository();
    const now = Date.now();
    repo.seed({
      tokenHash: 'idle2',
      loginAt: new Date(now - 2 * HOUR).toISOString(),
      lastSeenAt: new Date(now - (INACTIVITY_TTL_MS + 60_000)).toISOString(),
      expiresAt: new Date(now + 6 * HOUR).toISOString(),
    });
    expect(await repo.findByTokenHash('idle2')).toBeNull();
  });

  it('findRevoked includes expired and idle sessions, not just revoked ones', async () => {
    const repo = new InMemorySessionRepository();
    const now = Date.now();
    // revoked
    repo.seed({ tokenHash: 'r', revokedAt: new Date(now - HOUR).toISOString() });
    // expired (absolute)
    repo.seed({
      tokenHash: 'e',
      loginAt: new Date(now - 9 * HOUR).toISOString(),
      expiresAt: new Date(now - HOUR).toISOString(),
    });
    // idle
    repo.seed({
      tokenHash: 'i',
      loginAt: new Date(now - 2 * HOUR).toISOString(),
      lastSeenAt: new Date(now - (INACTIVITY_TTL_MS + 60_000)).toISOString(),
      expiresAt: new Date(now + 6 * HOUR).toISOString(),
    });
    // alive — must NOT appear in history
    repo.seed({
      tokenHash: 'a',
      loginAt: new Date(now - 10 * 60_000).toISOString(),
      lastSeenAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 7 * HOUR).toISOString(),
    });
    const page = await repo.findRevoked(1, 50);
    expect(page.total).toBe(3);
    expect(page.items.map(s => s.tokenHash).sort()).toEqual(['e', 'i', 'r']);
  });
});
