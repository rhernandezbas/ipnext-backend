/**
 * Tests for InMemorySessionRepository.findRevoked (SDD sessions-history Phase 2).
 */
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';

function makeRepo() {
  const repo = new InMemorySessionRepository();
  // 2 active sessions
  repo.seed({ tokenHash: 'active-1', revokedAt: null });
  repo.seed({ tokenHash: 'active-2', revokedAt: null });
  // 3 revoked sessions with distinct revokedAt timestamps
  repo.seed({ tokenHash: 'revoked-early',  revokedAt: '2026-05-01T10:00:00.000Z', loginAt: '2026-04-01T10:00:00.000Z' });
  repo.seed({ tokenHash: 'revoked-middle', revokedAt: '2026-05-15T10:00:00.000Z', loginAt: '2026-04-01T10:00:00.000Z' });
  repo.seed({ tokenHash: 'revoked-latest', revokedAt: '2026-05-25T10:00:00.000Z', loginAt: '2026-04-01T10:00:00.000Z' });
  return repo;
}

describe('InMemorySessionRepository.findRevoked', () => {
  it('returns only revoked sessions, total: 3', async () => {
    const repo = makeRepo();
    const result = await repo.findRevoked(1, 20);
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.revokedAt).not.toBeNull();
    }
  });

  it('excludes active sessions', async () => {
    const repo = makeRepo();
    const result = await repo.findRevoked(1, 20);
    const tokenHashes = result.items.map(i => i.tokenHash);
    expect(tokenHashes).not.toContain('active-1');
    expect(tokenHashes).not.toContain('active-2');
  });

  it('orders items revokedAt DESC (latest first)', async () => {
    const repo = makeRepo();
    const result = await repo.findRevoked(1, 20);
    const dates = result.items.map(i => i.revokedAt as string);
    expect(dates[0]).toBe('2026-05-25T10:00:00.000Z');
    expect(dates[1]).toBe('2026-05-15T10:00:00.000Z');
    expect(dates[2]).toBe('2026-05-01T10:00:00.000Z');
  });

  it('paginates: page 1 pageSize 2 → 2 items, total: 3', async () => {
    const repo = makeRepo();
    const result = await repo.findRevoked(1, 2);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
  });

  it('paginates: page 2 pageSize 2 → 1 item, total: 3', async () => {
    const repo = makeRepo();
    const result = await repo.findRevoked(2, 2);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(3);
    expect(result.page).toBe(2);
  });

  it('seed helper exposes tokenHash in domain objects (raw domain layer)', async () => {
    const repo = new InMemorySessionRepository();
    repo.seed({ tokenHash: 'secret-hash', revokedAt: '2026-05-01T10:00:00.000Z' });
    const result = await repo.findRevoked(1, 20);
    expect(result.items[0]).toHaveProperty('tokenHash', 'secret-hash');
  });
});
