import { ListRolesForUser } from '@application/use-cases/rbac/ListRolesForUser';
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

describe('ListRolesForUser', () => {
  it('returns 2 RbacRoleDto for user with 2 roles', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role1 = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const role2 = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });
    await userRoleRepo.assign(user.id, role1.id);
    await userRoleRepo.assign(user.id, role2.id);

    const uc = new ListRolesForUser(userRepo, userRoleRepo, roleRepo);
    const result = await uc.execute(user.id);

    expect(result).toHaveLength(2);
    const codes = result.map(r => r.code);
    expect(codes).toContain('admin');
    expect(codes).toContain('ventas');
  });

  it('returns empty array for user with 0 roles', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const user = await userRepo.create({ name: 'Bob', email: 'b@t.com', login: 'bob', passwordHash: 'h' });

    const uc = new ListRolesForUser(userRepo, userRoleRepo, roleRepo);
    const result = await uc.execute(user.id);

    expect(result).toEqual([]);
  });

  it('throws UserNotFoundError for non-existent userId', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const uc = new ListRolesForUser(userRepo, userRoleRepo, roleRepo);
    await expect(uc.execute('non-existent')).rejects.toThrow(UserNotFoundError);
  });
});
