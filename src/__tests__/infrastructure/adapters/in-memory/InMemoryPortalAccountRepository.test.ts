import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';

describe('InMemoryPortalAccountRepository', () => {
  it('create() returns an active account with mustChangePassword=true by default', async () => {
    const repo = new InMemoryPortalAccountRepository();
    const account = await repo.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'hash1' });
    expect(account.id).toBeTruthy();
    expect(account.clientId).toBe('client-1');
    expect(account.dni).toBe('30111222');
    expect(account.passwordHash).toBe('hash1');
    expect(account.status).toBe('active');
    expect(account.mustChangePassword).toBe(true);
    expect(account.lastLoginAt).toBeNull();
  });

  it('findById() returns null for an unknown id', async () => {
    const repo = new InMemoryPortalAccountRepository();
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findByDni() finds the exact match, and only the exact match', async () => {
    const repo = new InMemoryPortalAccountRepository();
    await repo.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'h1' });
    await repo.create({ clientId: 'client-2', dni: '30333444', passwordHash: 'h2' });

    const found = await repo.findByDni('30333444');
    expect(found?.clientId).toBe('client-2');
    expect(await repo.findByDni('99999999')).toBeNull();
  });

  it('findByClientId() finds the account tied to that client', async () => {
    const repo = new InMemoryPortalAccountRepository();
    const created = await repo.create({ clientId: 'client-9', dni: '30555666', passwordHash: 'h' });
    const found = await repo.findByClientId('client-9');
    expect(found?.id).toBe(created.id);
  });

  it('update() patches only the given fields and returns the fresh entity', async () => {
    const repo = new InMemoryPortalAccountRepository();
    const created = await repo.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'h1' });
    const now = new Date();

    const updated = await repo.update(created.id, {
      passwordHash: 'h2',
      status: 'disabled',
      mustChangePassword: false,
      lastLoginAt: now,
    });

    expect(updated.passwordHash).toBe('h2');
    expect(updated.status).toBe('disabled');
    expect(updated.mustChangePassword).toBe(false);
    expect(updated.lastLoginAt).toBe(now.toISOString());
    // untouched field survives the patch
    expect(updated.dni).toBe('30111222');
  });

  it('update() on an unknown id rejects', async () => {
    const repo = new InMemoryPortalAccountRepository();
    await expect(repo.update('nope', { status: 'disabled' })).rejects.toThrow();
  });

  it('delete() removes the account', async () => {
    const repo = new InMemoryPortalAccountRepository();
    const created = await repo.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'h1' });
    await repo.delete(created.id);
    expect(await repo.findById(created.id)).toBeNull();
  });
});
