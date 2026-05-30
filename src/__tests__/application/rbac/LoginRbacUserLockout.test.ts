/**
 * SDD #6a Phase 3 — account lockout in LoginRbacUser.
 */
import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { AuthenticationError, AccountLockedError } from '@domain/errors';

const NOW = new Date('2026-06-01T12:00:00.000Z');

async function setup() {
  const repo = new InMemoryRbacUserRepository();
  const hasher = new InMemoryPasswordHasher();
  const login = new LoginRbacUser(repo, hasher, () => NOW);
  await repo.create({
    name: 'Ana', email: 'ana@x', login: 'ana',
    passwordHash: await hasher.hash('correct-pass'),
    status: 'active',
  });
  return { repo, hasher, login };
}

describe('LoginRbacUser — account lockout', () => {
  it('locks the account after 5 failed attempts', async () => {
    const { repo, login } = await setup();
    for (let i = 0; i < 5; i++) {
      await expect(login.execute({ login: 'ana', password: 'wrong' })).rejects.toThrow();
    }
    const user = await repo.findByLogin('ana');
    expect(user!.lockedUntil).not.toBeNull();
    expect(new Date(user!.lockedUntil as string).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('rejects a locked account with AccountLockedError even with the correct password', async () => {
    const { repo, login } = await setup();
    for (let i = 0; i < 5; i++) {
      await login.execute({ login: 'ana', password: 'wrong' }).catch(() => undefined);
    }
    await expect(login.execute({ login: 'ana', password: 'correct-pass' }))
      .rejects.toThrow(AccountLockedError);
    void repo;
  });

  it('resets failedLoginCount on a successful login', async () => {
    const { repo, login } = await setup();
    await login.execute({ login: 'ana', password: 'wrong' }).catch(() => undefined);
    await login.execute({ login: 'ana', password: 'wrong' }).catch(() => undefined);
    await login.execute({ login: 'ana', password: 'correct-pass' });
    const user = await repo.findByLogin('ana');
    expect(user!.failedLoginCount).toBe(0);
    expect(user!.lockedUntil).toBeNull();
  });

  it('unknown login throws generic AuthenticationError (no lock)', async () => {
    const { login } = await setup();
    await expect(login.execute({ login: 'ghost', password: 'x' }))
      .rejects.toThrow(AuthenticationError);
  });
});
