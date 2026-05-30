/**
 * Shared contract tests for SessionRepository (InMemory always; Prisma skip-gated).
 * Factory returns a FRESH, EMPTY repo — create is part of the contract.
 */
import type { SessionRepository, CreateSessionInput } from '@domain/ports/SessionRepository';

const base: CreateSessionInput = {
  rbacUserId: 'u1',
  actorLogin: 'ana',
  tokenHash: 'hash-1',
  ip: '1.2.3.4',
  userAgent: 'jest',
};

export function runSessionContractTests(makeRepo: () => Promise<SessionRepository>): void {
  describe('create + findByTokenHash', () => {
    it('persists an active session and finds it by tokenHash', async () => {
      const repo = await makeRepo();
      const created = await repo.create(base);
      expect(typeof created.id).toBe('string');
      expect(created.revokedAt).toBeNull();
      const found = await repo.findByTokenHash('hash-1');
      expect(found).not.toBeNull();
      expect(found!.actorLogin).toBe('ana');
    });

    it('returns null for an unknown tokenHash', async () => {
      const repo = await makeRepo();
      expect(await repo.findByTokenHash('nope')).toBeNull();
    });
  });

  describe('revoke', () => {
    it('makes the session no longer findable by tokenHash (inactive)', async () => {
      const repo = await makeRepo();
      const s = await repo.create(base);
      await repo.revoke(s.id);
      expect(await repo.findByTokenHash('hash-1')).toBeNull();
    });
  });

  describe('listActive', () => {
    it('returns only active sessions with total + pageSize', async () => {
      const repo = await makeRepo();
      const a = await repo.create({ ...base, tokenHash: 'a' });
      await repo.create({ ...base, tokenHash: 'b' });
      await repo.revoke(a.id);
      const page = await repo.listActive({ page: 1, pageSize: 10 });
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].revokedAt).toBeNull();
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes every active session of the user and returns the count', async () => {
      const repo = await makeRepo();
      await repo.create({ ...base, tokenHash: 'a' });
      await repo.create({ ...base, tokenHash: 'b' });
      const count = await repo.revokeAllForUser('u1');
      expect(count).toBe(2);
      expect((await repo.listActive({ rbacUserId: 'u1' })).total).toBe(0);
    });
  });
}
