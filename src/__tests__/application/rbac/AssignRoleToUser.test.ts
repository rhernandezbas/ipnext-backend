import { AssignRoleToUser } from '@application/use-cases/rbac/AssignRoleToUser';
import { UserNotFoundError, RoleNotFoundError } from '@domain/errors/rbacUser.errors';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';

function makeRepos() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  return { userRepo, userRoleRepo, roleRepo };
}

describe('AssignRoleToUser', () => {
  it('assigns role to user — both exist', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });

    const uc = new AssignRoleToUser(userRepo, roleRepo, userRoleRepo);
    await uc.execute(user.id, role.id);

    const roleIds = await userRoleRepo.listForUser(user.id);
    expect(roleIds).toContain(role.id);
  });

  it('calling twice with same args is idempotent (no error)', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });

    const uc = new AssignRoleToUser(userRepo, roleRepo, userRoleRepo);
    await uc.execute(user.id, role.id);
    await expect(uc.execute(user.id, role.id)).resolves.toBeUndefined();

    const roleIds = await userRoleRepo.listForUser(user.id);
    expect(roleIds).toHaveLength(1);
  });

  it('throws UserNotFoundError for non-existent userId', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });

    const uc = new AssignRoleToUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute('non-existent', role.id)).rejects.toThrow(UserNotFoundError);
  });

  it('throws RoleNotFoundError for non-existent roleId', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });

    const uc = new AssignRoleToUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute(user.id, 'non-existent-role')).rejects.toThrow(RoleNotFoundError);
  });
});
