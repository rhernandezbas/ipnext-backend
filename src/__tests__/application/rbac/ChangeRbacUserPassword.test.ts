import { ChangeRbacUserPassword } from '@application/use-cases/rbac/ChangeRbacUserPassword';
import {
  PasswordPolicyError,
  UserNotFoundError,
  InvalidOldPasswordError,
} from '@domain/errors/rbacUser.errors';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

function makeRepos() {
  const userRepo = new InMemoryRbacUserRepository();
  const hasher = new InMemoryPasswordHasher();
  return { userRepo, hasher };
}

describe('ChangeRbacUserPassword', () => {
  it('admin-managed: updates hash without old password check', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'hashed::oldpass' });

    const uc = new ChangeRbacUserPassword(userRepo, hasher);
    await uc.execute(user.id, { newPassword: 'newpass123' }, true);

    const stored = await userRepo.findByLogin('alice');
    expect(stored!.passwordHash).toBe('hashed::newpass123');
  });

  it('self-change with correct oldPassword updates hash', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'hashed::oldpass' });

    const uc = new ChangeRbacUserPassword(userRepo, hasher);
    await uc.execute(user.id, { newPassword: 'newpass123', oldPassword: 'oldpass' }, false);

    const stored = await userRepo.findByLogin('alice');
    expect(stored!.passwordHash).toBe('hashed::newpass123');
  });

  it('self-change with wrong oldPassword throws InvalidOldPasswordError', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'hashed::oldpass' });

    const uc = new ChangeRbacUserPassword(userRepo, hasher);
    await expect(
      uc.execute(user.id, { newPassword: 'newpass123', oldPassword: 'wrongpass' }, false)
    ).rejects.toThrow(InvalidOldPasswordError);
  });

  it('self-change without oldPassword throws InvalidOldPasswordError', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'hashed::oldpass' });

    const uc = new ChangeRbacUserPassword(userRepo, hasher);
    await expect(
      uc.execute(user.id, { newPassword: 'newpass123' }, false)
    ).rejects.toThrow(InvalidOldPasswordError);
  });

  it('weak newPassword throws PasswordPolicyError', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h' });

    const uc = new ChangeRbacUserPassword(userRepo, hasher);
    await expect(
      uc.execute(user.id, { newPassword: 'short' }, true)
    ).rejects.toThrow(PasswordPolicyError);
  });

  it('non-existent user throws UserNotFoundError', async () => {
    const { userRepo, hasher } = makeRepos();
    const uc = new ChangeRbacUserPassword(userRepo, hasher);
    await expect(
      uc.execute('non-existent', { newPassword: 'newpass123' }, true)
    ).rejects.toThrow(UserNotFoundError);
  });
});
