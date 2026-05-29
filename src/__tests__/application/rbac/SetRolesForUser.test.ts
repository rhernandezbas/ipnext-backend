import { SetRolesForUser } from '@application/use-cases/rbac/SetRolesForUser';
import {
  UserNotFoundError,
  RoleNotFoundError,
  CannotRemoveLastSuperAdminError,
  AtLeastOneRoleRequiredError,
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

describe('SetRolesForUser', () => {
  it('user has [A, B], new set [B, C] → A revoked, C assigned, B unchanged; returns [B, C]', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const roleA = await roleRepo.create({ code: 'role_a', label: 'Role A', isSystem: true });
    const roleB = await roleRepo.create({ code: 'role_b', label: 'Role B', isSystem: true });
    const roleC = await roleRepo.create({ code: 'role_c', label: 'Role C', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });
    await userRoleRepo.assign(user.id, roleA.id);
    await userRoleRepo.assign(user.id, roleB.id);

    const uc = new SetRolesForUser(userRepo, roleRepo, userRoleRepo);
    const result = await uc.execute(user.id, [roleB.id, roleC.id]);

    const codes = result.map(r => r.code);
    expect(codes).toContain('role_b');
    expect(codes).toContain('role_c');
    expect(codes).not.toContain('role_a');
    expect(result).toHaveLength(2);

    // Verify via repo
    const currentIds = await userRoleRepo.listForUser(user.id);
    expect(currentIds).toContain(roleB.id);
    expect(currentIds).toContain(roleC.id);
    expect(currentIds).not.toContain(roleA.id);
  });

  it('last super_admin + new set removes super_admin → throws CannotRemoveLastSuperAdminError', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const superRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const adminRole = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });
    await userRoleRepo.assign(user.id, superRole.id);

    const uc = new SetRolesForUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute(user.id, [adminRole.id])).rejects.toThrow(CannotRemoveLastSuperAdminError);
  });

  it('one of 2 super_admins + new set removes super_admin → succeeds', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const superRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const adminRole = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const user1 = await userRepo.create({ name: 'Admin1', email: 'a1@t.com', login: 'admin1', passwordHash: 'h' });
    const user2 = await userRepo.create({ name: 'Admin2', email: 'a2@t.com', login: 'admin2', passwordHash: 'h' });
    await userRoleRepo.assign(user1.id, superRole.id);
    await userRoleRepo.assign(user2.id, superRole.id);

    const uc = new SetRolesForUser(userRepo, roleRepo, userRoleRepo);
    const result = await uc.execute(user2.id, [adminRole.id]);

    expect(result.map(r => r.code)).toContain('admin');
    expect(result.map(r => r.code)).not.toContain('super_admin');
  });

  it('throws RoleNotFoundError for unknown roleId in new set', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });
    const validRole = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    await userRoleRepo.assign(user.id, validRole.id);

    const uc = new SetRolesForUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute(user.id, ['non-existent-role'])).rejects.toThrow(RoleNotFoundError);
  });

  it('idempotent repeat (same roleIds twice) → second call returns same DTOs, no extra side-effects', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const roleA = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });
    await userRoleRepo.assign(user.id, roleA.id);

    const uc = new SetRolesForUser(userRepo, roleRepo, userRoleRepo);
    const result1 = await uc.execute(user.id, [roleA.id]);
    const result2 = await uc.execute(user.id, [roleA.id]);

    expect(result1.map(r => r.code)).toEqual(result2.map(r => r.code));
    const currentIds = await userRoleRepo.listForUser(user.id);
    expect(currentIds).toEqual([roleA.id]);
  });

  it('throws UserNotFoundError for non-existent userId', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });

    const uc = new SetRolesForUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute('non-existent', [role.id])).rejects.toThrow(UserNotFoundError);
  });

  it('throws AtLeastOneRoleRequiredError for empty roleIds', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'a@t.com', login: 'alice', passwordHash: 'h' });

    const uc = new SetRolesForUser(userRepo, roleRepo, userRoleRepo);
    await expect(uc.execute(user.id, [])).rejects.toThrow(AtLeastOneRoleRequiredError);
  });
});
