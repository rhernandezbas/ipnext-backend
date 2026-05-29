/**
 * ListRbacUsers use case tests — RED first.
 */
import { ListRbacUsers } from '@application/use-cases/rbac/ListRbacUsers';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';

function makeRepos() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  return { userRepo, userRoleRepo, roleRepo };
}

describe('ListRbacUsers', () => {
  it('should return empty array when no users exist', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const uc = new ListRbacUsers(userRepo, userRoleRepo, roleRepo);
    const result = await uc.execute();
    expect(result).toEqual([]);
  });

  it('should return all users with their roles', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    const role = await roleRepo.create({ code: 'admin', label: 'Admin', isSystem: true });
    const user1 = await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'h1' });
    const user2 = await userRepo.create({ name: 'Bob', email: 'bob@test.com', login: 'bob', passwordHash: 'h2' });
    await userRoleRepo.assign(user1.id, role.id);

    const uc = new ListRbacUsers(userRepo, userRoleRepo, roleRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(2);
    const alice = result.find(u => u.login === 'alice')!;
    expect(alice.roles).toHaveLength(1);
    expect(alice.roles[0].code).toBe('admin');
    const bob = result.find(u => u.login === 'bob')!;
    expect(bob.roles).toHaveLength(0);
  });

  it('should not include passwordHash in any DTO', async () => {
    const { userRepo, userRoleRepo, roleRepo } = makeRepos();
    await userRepo.create({ name: 'Alice', email: 'alice@test.com', login: 'alice', passwordHash: 'secret-hash' });
    const uc = new ListRbacUsers(userRepo, userRoleRepo, roleRepo);
    const result = await uc.execute();
    const json = JSON.stringify(result);
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('secret-hash');
  });
});
