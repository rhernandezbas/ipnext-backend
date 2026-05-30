/**
 * SDD #5 Phase 1 — session use cases over InMemorySessionRepository.
 */
import { CreateSession } from '@application/use-cases/sessions/CreateSession';
import { ListActiveSessions } from '@application/use-cases/sessions/ListActiveSessions';
import { RevokeSession } from '@application/use-cases/sessions/RevokeSession';
import { RevokeAllSessionsForUser } from '@application/use-cases/sessions/RevokeAllSessionsForUser';
import { SessionNotFoundError } from '@domain/errors/session.errors';
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';

function makeRepo() {
  const repo = new InMemorySessionRepository();
  repo.seed({ id: 's1', rbacUserId: 'u1', actorLogin: 'ana',  tokenHash: 'h1', loginAt: '2026-05-01T10:00:00.000Z' });
  repo.seed({ id: 's2', rbacUserId: 'u1', actorLogin: 'ana',  tokenHash: 'h2', loginAt: '2026-05-10T10:00:00.000Z' });
  repo.seed({ id: 's3', rbacUserId: 'u2', actorLogin: 'beto', tokenHash: 'h3', loginAt: '2026-05-20T10:00:00.000Z' });
  repo.seed({ id: 's4', rbacUserId: 'u2', actorLogin: 'beto', tokenHash: 'h4', loginAt: '2026-05-25T10:00:00.000Z', revokedAt: '2026-05-26T10:00:00.000Z' });
  return repo;
}

describe('CreateSession', () => {
  it('creates an active session', async () => {
    const repo = new InMemorySessionRepository();
    const session = await new CreateSession(repo).execute({
      rbacUserId: 'u1', actorLogin: 'ana', tokenHash: 'abc', ip: '1.2.3.4', userAgent: 'jest',
    });
    expect(session).toMatchObject({ rbacUserId: 'u1', actorLogin: 'ana', tokenHash: 'abc', revokedAt: null });
    expect(session.id).toEqual(expect.any(String));
    expect(await repo.findByTokenHash('abc')).not.toBeNull();
  });
});

describe('ListActiveSessions', () => {
  it('returns only active sessions as DTOs WITHOUT tokenHash, newest first', async () => {
    const res = await new ListActiveSessions(makeRepo()).execute({ page: 1, pageSize: 50 });
    expect(res).toMatchObject({ total: 3, page: 1, pageSize: 50 }); // s4 is revoked → excluded
    expect(res.items).toHaveLength(3);
    expect(res.items[0]).not.toHaveProperty('tokenHash');
    expect(res.items[0]).toMatchObject({ actorLogin: expect.any(String) });
    expect(res.items[0].loginAt).toBe('2026-05-20T10:00:00.000Z'); // newest active = s3
  });

  it('filters by rbacUserId', async () => {
    const res = await new ListActiveSessions(makeRepo()).execute({ rbacUserId: 'u1' });
    expect(res.total).toBe(2);
    expect(res.items.every(s => s.rbacUserId === 'u1')).toBe(true);
  });

  it('paginates', async () => {
    const uc = new ListActiveSessions(makeRepo());
    const p1 = await uc.execute({ page: 1, pageSize: 2 });
    const p2 = await uc.execute({ page: 2, pageSize: 2 });
    expect(p1.total).toBe(3);
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
  });
});

describe('RevokeSession', () => {
  it('revokes an existing session (no longer active)', async () => {
    const repo = makeRepo();
    await new RevokeSession(repo).execute('s1');
    expect(await repo.findByTokenHash('h1')).toBeNull(); // revoked → not returned as active
    const res = await new ListActiveSessions(repo).execute({});
    expect(res.items.find(s => s.id === 's1')).toBeUndefined();
  });

  it('throws SessionNotFoundError for an unknown id', async () => {
    await expect(new RevokeSession(makeRepo()).execute('nope')).rejects.toThrow(SessionNotFoundError);
  });
});

describe('RevokeAllSessionsForUser', () => {
  it('revokes every active session of the user and returns the count', async () => {
    const repo = makeRepo();
    const count = await new RevokeAllSessionsForUser(repo).execute('u1');
    expect(count).toBe(2); // s1 + s2
    const res = await new ListActiveSessions(repo).execute({ rbacUserId: 'u1' });
    expect(res.total).toBe(0);
  });

  it('returns 0 when the user has no active sessions', async () => {
    const count = await new RevokeAllSessionsForUser(makeRepo()).execute('ghost');
    expect(count).toBe(0);
  });
});
