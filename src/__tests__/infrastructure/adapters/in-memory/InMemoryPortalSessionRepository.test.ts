import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';

describe('InMemoryPortalSessionRepository', () => {
  it('create() returns a fresh session, never revoked/rotated', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const expiresAt = new Date(Date.now() + 60_000);
    const session = await repo.create({ accountId: 'acc-1', tokenHash: 'hash1', expiresAt });
    expect(session.id).toBeTruthy();
    expect(session.accountId).toBe('acc-1');
    expect(session.tokenHash).toBe('hash1');
    expect(session.expiresAt).toBe(expiresAt.toISOString());
    expect(session.revokedAt).toBeNull();
    expect(session.rotatedAt).toBeNull();
  });

  it('findByTokenHash() returns the session regardless of its state (revoked/rotated included)', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const created = await repo.create({ accountId: 'acc-1', tokenHash: 'hash1', expiresAt: new Date(Date.now() + 60_000) });
    await repo.markRotated(created.id);

    const found = await repo.findByTokenHash('hash1');
    expect(found?.id).toBe(created.id);
    expect(found?.rotatedAt).not.toBeNull();
  });

  it('findByTokenHash() returns null for an unknown hash', async () => {
    const repo = new InMemoryPortalSessionRepository();
    expect(await repo.findByTokenHash('nope')).toBeNull();
  });

  it('markRotated() sets rotatedAt exactly once', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const created = await repo.create({ accountId: 'acc-1', tokenHash: 'hash1', expiresAt: new Date(Date.now() + 60_000) });
    await repo.markRotated(created.id);
    const found = await repo.findByTokenHash('hash1');
    expect(found?.rotatedAt).not.toBeNull();
  });

  it('markRotated() on a REVOKED session returns false — the CAS covers revoke-vs-rotate, not just rotate-vs-rotate (re-review fix)', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const created = await repo.create({ accountId: 'acc-1', tokenHash: 'hash1', expiresAt: new Date(Date.now() + 60_000) });
    await repo.revoke(created.id);

    await expect(repo.markRotated(created.id)).resolves.toBe(false);
    const found = await repo.findByTokenHash('hash1');
    expect(found?.rotatedAt).toBeNull();
  });

  it('revoke() sets revokedAt', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const created = await repo.create({ accountId: 'acc-1', tokenHash: 'hash1', expiresAt: new Date(Date.now() + 60_000) });
    await repo.revoke(created.id);
    const found = await repo.findByTokenHash('hash1');
    expect(found?.revokedAt).not.toBeNull();
  });

  it('revokeAllForAccount() revokes every non-revoked session of that account and returns the count', async () => {
    const repo = new InMemoryPortalSessionRepository();
    await repo.create({ accountId: 'acc-1', tokenHash: 'h1', expiresAt: new Date(Date.now() + 60_000) });
    await repo.create({ accountId: 'acc-1', tokenHash: 'h2', expiresAt: new Date(Date.now() + 60_000) });
    await repo.create({ accountId: 'acc-2', tokenHash: 'h3', expiresAt: new Date(Date.now() + 60_000) });

    const count = await repo.revokeAllForAccount('acc-1');
    expect(count).toBe(2);

    const other = await repo.findByTokenHash('h3');
    expect(other?.revokedAt).toBeNull();
  });

  it('revokeAllForAccount() does not double-count an already-revoked session', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const created = await repo.create({ accountId: 'acc-1', tokenHash: 'h1', expiresAt: new Date(Date.now() + 60_000) });
    await repo.revoke(created.id);
    const count = await repo.revokeAllForAccount('acc-1');
    expect(count).toBe(0);
  });
});
