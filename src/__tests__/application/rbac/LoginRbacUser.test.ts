import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { AuthenticationError } from '@domain/errors';

function makeRepo() {
  return new InMemoryRbacUserRepository();
}

describe('LoginRbacUser', () => {
  it('happy path: valid login + matching password → returns safe user fields', async () => {
    const repo = makeRepo();
    const hasher = new InMemoryPasswordHasher();
    const useCase = new LoginRbacUser(repo, hasher);

    const passwordHash = await hasher.hash('password123');
    const created = await repo.create({
      name: 'Alice',
      email: 'alice@example.com',
      login: 'alice',
      passwordHash,
      status: 'active',
    });

    const result = await useCase.execute({ login: 'alice', password: 'password123' });

    expect(result.id).toBe(created.id);
    expect(result.login).toBe('alice');
    expect(result.email).toBe('alice@example.com');
    expect(result.name).toBe('Alice');
    expect((result as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('unknown login → throws AuthenticationError', async () => {
    const repo = makeRepo();
    const hasher = new InMemoryPasswordHasher();
    const useCase = new LoginRbacUser(repo, hasher);

    await expect(useCase.execute({ login: 'nobody', password: 'whatever' }))
      .rejects.toThrow(AuthenticationError);
  });

  it('wrong password → throws AuthenticationError', async () => {
    const repo = makeRepo();
    const hasher = new InMemoryPasswordHasher();
    const useCase = new LoginRbacUser(repo, hasher);

    await repo.create({
      name: 'Bob',
      email: 'bob@example.com',
      login: 'bob',
      passwordHash: await hasher.hash('correct'),
      status: 'active',
    });

    await expect(useCase.execute({ login: 'bob', password: 'wrong' }))
      .rejects.toThrow(AuthenticationError);
  });

  it('disabled user → throws AuthenticationError', async () => {
    const repo = makeRepo();
    const hasher = new InMemoryPasswordHasher();
    const useCase = new LoginRbacUser(repo, hasher);

    await repo.create({
      name: 'Carol',
      email: 'carol@example.com',
      login: 'carol',
      passwordHash: await hasher.hash('mypass12'),
      status: 'disabled',
    });

    await expect(useCase.execute({ login: 'carol', password: 'mypass12' }))
      .rejects.toThrow(AuthenticationError);
  });

  it('after successful login, updateLastLogin is called (lastLoginAt is set)', async () => {
    const repo = makeRepo();
    const hasher = new InMemoryPasswordHasher();
    const useCase = new LoginRbacUser(repo, hasher);

    const created = await repo.create({
      name: 'Dave',
      email: 'dave@example.com',
      login: 'dave',
      passwordHash: await hasher.hash('pass1234'),
      status: 'active',
    });

    // lastLoginAt should be null before login
    const before = await repo.findById(created.id);
    expect(before?.lastLoginAt).toBeNull();

    await useCase.execute({ login: 'dave', password: 'pass1234' });

    const after = await repo.findById(created.id);
    expect(after?.lastLoginAt).not.toBeNull();
  });
});
