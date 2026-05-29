import { DeleteRbacUser } from '@application/use-cases/rbac/DeleteRbacUser';
import {
  CannotDeleteSelfError,
  CannotRemoveLastSuperAdminError,
  UserNotFoundError,
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

function makeUC(userRepo: InstanceType<typeof InMemoryRbacUserRepository>, userRoleRepo: InstanceType<typeof InMemoryRbacUserRoleRepository>, roleRepo: InstanceType<typeof InMemoryRbacRoleRepository>) {
  return new DeleteRbacUser(userRepo, userRoleRepo, roleRepo);
}

describe('DeleteRbacUser', () => {
  it('deletes non-self, non-last-super_admin user', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const actor = await userRepo.create({ name: 'Actor', email: 'actor@test.com', login: 'actor', passwordHash: 'h' });
    const target = await userRepo.create({ name: 'Target', email: 'target@test.com', login: 'target', passwordHash: 'h' });
    await userRoleRepo.assign(target.id, role.id);

    const uc = makeUC(userRepo, userRoleRepo, roleRepo);
    await uc.execute(target.id, actor.id);

    const found = await userRepo.findById(target.id);
    expect(found).toBeNull();
  });

  it('should throw CannotDeleteSelfError when id === requestingUserId', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const user = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h' });

    const uc = makeUC(userRepo, userRoleRepo, roleRepo);
    await expect(uc.execute(user.id, user.id)).rejects.toThrow(CannotDeleteSelfError);
  });

  it('should throw CannotRemoveLastSuperAdminError for sole super_admin', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const superRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const actor = await userRepo.create({ name: 'Actor', email: 'actor@test.com', login: 'actor', passwordHash: 'h' });
    const target = await userRepo.create({ name: 'Target', email: 'target@test.com', login: 'target', passwordHash: 'h' });
    await userRoleRepo.assign(target.id, superRole.id);

    const uc = makeUC(userRepo, userRoleRepo, roleRepo);
    await expect(uc.execute(target.id, actor.id)).rejects.toThrow(CannotRemoveLastSuperAdminError);
  });

  it('allows deleting one of 2 super_admins', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const superRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const admin1 = await userRepo.create({ name: 'Admin1', email: 'a1@test.com', login: 'admin1', passwordHash: 'h' });
    const admin2 = await userRepo.create({ name: 'Admin2', email: 'a2@test.com', login: 'admin2', passwordHash: 'h' });
    await userRoleRepo.assign(admin1.id, superRole.id);
    await userRoleRepo.assign(admin2.id, superRole.id);

    const uc = makeUC(userRepo, userRoleRepo, roleRepo);
    await uc.execute(admin2.id, admin1.id); // admin1 deletes admin2

    const found = await userRepo.findById(admin2.id);
    expect(found).toBeNull();
  });

  it('should throw UserNotFoundError for non-existent id', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const actor = await userRepo.create({ name: 'Actor', email: 'a@test.com', login: 'actor', passwordHash: 'h' });

    const uc = makeUC(userRepo, userRoleRepo, roleRepo);
    await expect(uc.execute('non-existent', actor.id)).rejects.toThrow(UserNotFoundError);
  });
});
