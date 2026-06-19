import { UpdateRbacUser } from '@application/use-cases/rbac/UpdateRbacUser';
import {
  PasswordTooShortError,
  LoginAlreadyTakenError,
  UserNotFoundError,
} from '@domain/errors/rbacUser.errors';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

function makeRepos() {
  const userRepo = new InMemoryRbacUserRepository();
  const hasher = new InMemoryPasswordHasher();
  return { userRepo, hasher };
}

describe('UpdateRbacUser', () => {
  it('partial patch (name only) should update only name, leave others unchanged', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h1' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    const result = await uc.execute(user.id, { name: 'Alice Updated' });

    expect(result.name).toBe('Alice Updated');
    expect(result.email).toBe('alice@test.com');
    expect(result.login).toBe('alice');
  });

  it('password="" should NOT change passwordHash', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'original-hash' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    await uc.execute(user.id, { password: '' });

    const stored = await userRepo.findByLogin('alice');
    expect(stored!.passwordHash).toBe('original-hash');
  });

  it('password="newpass1" (>=8) should update passwordHash', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'original-hash' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    await uc.execute(user.id, { password: 'newpass1' });

    const stored = await userRepo.findByLogin('alice');
    expect(stored!.passwordHash).toBe('hashed::newpass1');
  });

  it('short password should throw PasswordTooShortError', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h1' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    await expect(uc.execute(user.id, { password: 'short' })).rejects.toThrow(PasswordTooShortError);
  });

  it('duplicate login should throw LoginAlreadyTakenError', async () => {
    const { userRepo, hasher } = makeRepos();
    await userRepo.create({ name: 'Bob', email: 'bob@test.com', login: 'bob', passwordHash: 'h1' });
    const alice = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h2' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    await expect(uc.execute(alice.id, { login: 'bob' })).rejects.toThrow(LoginAlreadyTakenError);
  });

  it('non-existent id should throw UserNotFoundError', async () => {
    const { userRepo, hasher } = makeRepos();
    const uc = new UpdateRbacUser(userRepo, hasher);
    await expect(uc.execute('non-existent', { name: 'Test' })).rejects.toThrow(UserNotFoundError);
  });

  it('grVendedorName set should persist and be returned in the DTO', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h1' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    const result = await uc.execute(user.id, { grVendedorName: 'JUAN PEREZ' });

    expect(result.grVendedorName).toBe('JUAN PEREZ');
    // Re-read to confirm persistence
    const stored = await userRepo.findById(user.id);
    expect(stored!.grVendedorName).toBe('JUAN PEREZ');
  });

  it('grVendedorName=null should clear the mapping', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h1' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    await uc.execute(user.id, { grVendedorName: 'JUAN PEREZ' });
    const cleared = await uc.execute(user.id, { grVendedorName: null });

    expect(cleared.grVendedorName).toBeNull();
  });

  it('grVendedorName undefined should NOT touch the existing value', async () => {
    const { userRepo, hasher } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h1' });

    const uc = new UpdateRbacUser(userRepo, hasher);
    await uc.execute(user.id, { grVendedorName: 'MARIA LOPEZ' });
    // Update an unrelated field, leaving grVendedorName undefined
    const result = await uc.execute(user.id, { name: 'Alice 2' });

    expect(result.name).toBe('Alice 2');
    expect(result.grVendedorName).toBe('MARIA LOPEZ');
  });
});
