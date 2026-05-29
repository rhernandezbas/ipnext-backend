import { GetRbacUser } from '@application/use-cases/rbac/GetRbacUser';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';

function makeRepos() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  return { userRepo, userRoleRepo, roleRepo };
}

describe('GetRbacUser', () => {
  it('should return RbacUserWithRolesDto for existing user', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h1' });
    await userRoleRepo.assign(user.id, role.id);

    const uc = new GetRbacUser(userRepo, userRoleRepo, roleRepo);
    const result = await uc.execute(user.id);

    expect(result.id).toBe(user.id);
    expect(result.name).toBe('Alice');
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].code).toBe('super_admin');
  });

  it('should throw UserNotFoundError for non-existent id', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const uc = new GetRbacUser(userRepo, userRoleRepo, roleRepo);
    await expect(uc.execute('non-existent-id')).rejects.toThrow(UserNotFoundError);
  });

  it('should not include passwordHash in output', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'secret' });
    const uc = new GetRbacUser(userRepo, userRoleRepo, roleRepo);
    const result = await uc.execute(user.id);
    const json = JSON.stringify(result);
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('secret');
  });
});
