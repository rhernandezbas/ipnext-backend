/**
 * UnlockRbacUser use case tests — TDD RED phase.
 *
 * Desbloquear usuario: resetea failedLoginCount=0 y lockedUntil=null.
 */
import { UnlockRbacUser } from '@application/use-cases/rbac/UnlockRbacUser';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

function makeRepos() {
  const userRepo = new InMemoryRbacUserRepository();
  return { userRepo };
}

describe('UnlockRbacUser', () => {
  it('resets failedLoginCount=0 and lockedUntil=null for a locked user', async () => {
    const { userRepo } = makeRepos();
    const user = await userRepo.create({
      name: 'Alice',
      email: 'alice@test.com',
      login: 'alice',
      passwordHash: 'h1',
    });
    // Simulate locked state
    await userRepo.update(user.id, {
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
    });

    const uc = new UnlockRbacUser(userRepo);
    const result = await uc.execute(user.id);

    // DTO must include lockedUntil=null after unlock
    expect(result.lockedUntil).toBeNull();

    // Verify internal auth state was also reset
    const stored = await userRepo.findByLogin('alice');
    expect(stored!.failedLoginCount).toBe(0);
    expect(stored!.lockedUntil).toBeNull();
  });

  it('throws UserNotFoundError for non-existent user id', async () => {
    const { userRepo } = makeRepos();
    const uc = new UnlockRbacUser(userRepo);
    await expect(uc.execute('non-existent-id')).rejects.toThrow(UserNotFoundError);
  });

  it('is idempotent for a non-locked user — resets to 0/null regardless', async () => {
    const { userRepo } = makeRepos();
    const user = await userRepo.create({
      name: 'Bob',
      email: 'bob@test.com',
      login: 'bob',
      passwordHash: 'h2',
    });

    const uc = new UnlockRbacUser(userRepo);
    const result = await uc.execute(user.id);

    expect(result.lockedUntil).toBeNull();
    expect(result.id).toBe(user.id);
    expect(result.login).toBe('bob');
  });

  it('returned DTO does NOT expose failedLoginCount nor passwordHash', async () => {
    const { userRepo } = makeRepos();
    const user = await userRepo.create({
      name: 'Sec',
      email: 'sec@test.com',
      login: 'sec',
      passwordHash: 'secret-hash',
    });

    const uc = new UnlockRbacUser(userRepo);
    const result = await uc.execute(user.id);
    const json = JSON.stringify(result);

    expect(json).not.toContain('failedLoginCount');
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('secret-hash');
  });
});
