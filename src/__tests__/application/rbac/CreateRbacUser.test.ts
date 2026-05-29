import { CreateRbacUser } from '@application/use-cases/rbac/CreateRbacUser';
import {
  PasswordTooShortError,
  AtLeastOneRoleRequiredError,
  RoleNotFoundError,
  LoginAlreadyTakenError,
  EmailAlreadyTakenError,
} from '@domain/errors/rbacUser.errors';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

function makeRepos() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  const hasher = new InMemoryPasswordHasher();
  return { userRepo, userRoleRepo, roleRepo, hasher };
}

describe('CreateRbacUser', () => {
  it('happy path: creates user, assigns roles, returns DTO with roles', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    const result = await uc.execute({
      name: 'Alice',
      email: 'alice@test.com',
      login: 'alice',
      password: 'securepass',
      roleIds: [role.id],
    });

    expect(result.name).toBe('Alice');
    expect(result.email).toBe('alice@test.com');
    expect(result.login).toBe('alice');
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].code).toBe('admin');
  });

  it('should throw PasswordTooShortError when password < 8 chars', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    await expect(uc.execute({
      name: 'Alice',
      email: 'alice@test.com',
      login: 'alice',
      password: 'short',
      roleIds: [role.id],
    })).rejects.toThrow(PasswordTooShortError);
  });

  it('should throw AtLeastOneRoleRequiredError when roleIds is empty', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    await expect(uc.execute({
      name: 'Alice',
      email: 'alice@test.com',
      login: 'alice',
      password: 'securepass',
      roleIds: [],
    })).rejects.toThrow(AtLeastOneRoleRequiredError);
  });

  it('should throw RoleNotFoundError for unknown roleId', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    await expect(uc.execute({
      name: 'Alice',
      email: 'alice@test.com',
      login: 'alice',
      password: 'securepass',
      roleIds: ['non-existent-role-id'],
    })).rejects.toThrow(RoleNotFoundError);
  });

  it('should throw LoginAlreadyTakenError for duplicate login', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h' });
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    await expect(uc.execute({
      name: 'Alice2',
      email: 'alice2@test.com',
      login: 'alice',
      password: 'securepass',
      roleIds: [role.id],
    })).rejects.toThrow(LoginAlreadyTakenError);
  });

  it('should throw EmailAlreadyTakenError for duplicate email', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h' });
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    await expect(uc.execute({
      name: 'Alice2',
      email: 'alice@test.com',
      login: 'alice2',
      password: 'securepass',
      roleIds: [role.id],
    })).rejects.toThrow(EmailAlreadyTakenError);
  });

  it('should store hashed password (verify via findByLogin)', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    await uc.execute({
      name: 'Alice',
      email: 'alice@test.com',
      login: 'alice',
      password: 'mypassword',
      roleIds: [role.id],
    });

    const stored = await userRepo.findByLogin('alice');
    expect(stored).not.toBeNull();
    // InMemoryPasswordHasher prefixes "hashed::"
    expect(stored!.passwordHash).toBe('hashed::mypassword');
  });

  it('should not include passwordHash in returned DTO', async () => {
    const { userRepo, userRoleRepo, roleRepo, hasher } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const uc = new CreateRbacUser(userRepo, roleRepo, userRoleRepo, hasher);

    const result = await uc.execute({
      name: 'Alice',
      email: 'alice@test.com',
      login: 'alice',
      password: 'mypassword',
      roleIds: [role.id],
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain('passwordHash');
  });
});
