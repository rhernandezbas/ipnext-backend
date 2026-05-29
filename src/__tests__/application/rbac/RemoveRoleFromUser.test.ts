import { RemoveRoleFromUser } from '@application/use-cases/rbac/RemoveRoleFromUser';
import {
  UserNotFoundError,
  RoleNotFoundError,
  CannotRemoveLastSuperAdminError,
} from '@domain/errors/rbacUser.errors';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';

function makeRepos() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  return { userRepo, userRoleRepo, roleRepo };
}

describe('RemoveRoleFromUser', () => {
  it('revokes a non-super_admin role', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });
    await userRoleRepo.assign(user.id, role.id);

    const uc = new RemoveRoleFromUser(userRepo, roleRepo, userRoleRepo);
    await uc.execute(user.id, role.id);

    const roleIds = await userRoleRepo.listForUser(user.id);
    expect(roleIds).not.toContain(role.id);
  });

  it('throws CannotRemoveLastSuperAdminError for sole super_admin', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const superRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });
    await userRoleRepo.assign(user.id, superRole.id);

    const uc = new RemoveRoleFromUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute(user.id, superRole.id)).rejects.toThrow(CannotRemoveLastSuperAdminError);
  });

  it('one of 2 super_admins can have role revoked', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const superRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const admin1 = await userRepo.create({ name: 'Admin1', email: 'a1@t.com', login: 'admin1', passwordHash: 'h' });
    const admin2 = await userRepo.create({ name: 'Admin2', email: 'a2@t.com', login: 'admin2', passwordHash: 'h' });
    await userRoleRepo.assign(admin1.id, superRole.id);
    await userRoleRepo.assign(admin2.id, superRole.id);

    const uc = new RemoveRoleFromUser(userRepo, roleRepo, userRoleRepo);
    await uc.execute(admin2.id, superRole.id);

    const roleIds = await userRoleRepo.listForUser(admin2.id);
    expect(roleIds).not.toContain(superRole.id);
  });

  it('role not assigned to user is idempotent (no error)', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });

    const uc = new RemoveRoleFromUser(userRepo, roleRepo, userRoleRepo);
    // Role not assigned — should not throw
    await expect(uc.execute(user.id, role.id)).resolves.toBeUndefined();
  });

  it('throws UserNotFoundError for non-existent userId', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });

    const uc = new RemoveRoleFromUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute('non-existent', role.id)).rejects.toThrow(UserNotFoundError);
  });

  it('throws RoleNotFoundError for non-existent roleId', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });

    const uc = new RemoveRoleFromUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute(user.id, 'non-existent-role')).rejects.toThrow(RoleNotFoundError);
  });
});
