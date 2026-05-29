/**
 * Shared contract tests for RbacUserRoleRepository.
 *
 * Call `runRbacUserRoleContractTests(() => new YourRepo())` from both the
 * InMemory and Prisma test files.
 *
 * The factory `makeRepo` returns a fresh empty repo instance.
 * For the Prisma adapter, use `describe.skip` when DATABASE_URL_TEST is absent.
 */
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';

export function runRbacUserRoleContractTests(makeRepo: () => RbacUserRoleRepository): void {
  describe('assign + listForUser roundtrip', () => {
    it('returns the role id after assignment', async () => {
      const repo = makeRepo();
      await repo.assign('user-1', 'role-admin');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(1);
      expect(roleIds[0]).toBe('role-admin');
    });

    it('tracks multiple roles for the same user', async () => {
      const repo = makeRepo();
      await repo.assign('user-1', 'role-admin');
      await repo.assign('user-1', 'role-noc');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(2);
      expect(roleIds).toContain('role-admin');
      expect(roleIds).toContain('role-noc');
    });

    it('keeps roles isolated per user', async () => {
      const repo = makeRepo();
      await repo.assign('user-1', 'role-admin');
      await repo.assign('user-2', 'role-noc');
      const user1Roles = await repo.listForUser('user-1');
      const user2Roles = await repo.listForUser('user-2');
      expect(user1Roles).toEqual(['role-admin']);
      expect(user2Roles).toEqual(['role-noc']);
    });
  });

  describe('assign — idempotency', () => {
    it('assigning the same role twice does NOT duplicate it', async () => {
      const repo = makeRepo();
      await repo.assign('user-1', 'role-admin');
      await repo.assign('user-1', 'role-admin'); // second call — must be no-op
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(1);
      expect(roleIds[0]).toBe('role-admin');
    });

    it('does not throw on duplicate assignment', async () => {
      const repo = makeRepo();
      await repo.assign('user-1', 'role-admin');
      await expect(repo.assign('user-1', 'role-admin')).resolves.toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('removes the role from the user', async () => {
      const repo = makeRepo();
      await repo.assign('user-1', 'role-admin');
      await repo.revoke('user-1', 'role-admin');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(0);
    });

    it('only removes the targeted role, not others', async () => {
      const repo = makeRepo();
      await repo.assign('user-1', 'role-admin');
      await repo.assign('user-1', 'role-noc');
      await repo.revoke('user-1', 'role-admin');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toEqual(['role-noc']);
    });

    it('is a no-op when the assignment does not exist', async () => {
      const repo = makeRepo();
      await expect(repo.revoke('user-1', 'role-admin')).resolves.toBeUndefined();
    });
  });

  describe('listForUser', () => {
    it('returns empty array for a user with no assignments', async () => {
      const repo = makeRepo();
      const roleIds = await repo.listForUser('user-without-roles');
      expect(roleIds).toEqual([]);
    });
  });
}
