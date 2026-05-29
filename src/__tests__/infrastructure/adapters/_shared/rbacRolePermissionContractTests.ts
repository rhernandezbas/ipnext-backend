/**
 * Shared contract tests for RbacRolePermissionRepository.
 *
 * Call `runRbacRolePermissionContractTests(() => new YourRepo())` from both the
 * InMemory and Prisma test files.
 *
 * The factory `makeRepo` returns a fresh empty repo instance.
 * For the Prisma adapter, use `describe.skip` when DATABASE_URL_TEST is absent.
 */
import type { RbacRolePermissionRepository } from '@domain/ports/RbacRolePermissionRepository';

export function runRbacRolePermissionContractTests(
  makeRepo: () => RbacRolePermissionRepository,
): void {
  describe('grant + listForRole roundtrip', () => {
    it('returns the permission id after grant', async () => {
      const repo = makeRepo();
      await repo.grant('role-admin', 'perm-clients-read');
      const permIds = await repo.listForRole('role-admin');
      expect(permIds).toHaveLength(1);
      expect(permIds[0]).toBe('perm-clients-read');
    });

    it('tracks multiple permissions for the same role', async () => {
      const repo = makeRepo();
      await repo.grant('role-admin', 'perm-clients-read');
      await repo.grant('role-admin', 'perm-billing-write');
      const permIds = await repo.listForRole('role-admin');
      expect(permIds).toHaveLength(2);
      expect(permIds).toContain('perm-clients-read');
      expect(permIds).toContain('perm-billing-write');
    });

    it('keeps permissions isolated per role', async () => {
      const repo = makeRepo();
      await repo.grant('role-admin', 'perm-clients-read');
      await repo.grant('role-noc', 'perm-network-manage');
      const adminPerms = await repo.listForRole('role-admin');
      const nocPerms = await repo.listForRole('role-noc');
      expect(adminPerms).toEqual(['perm-clients-read']);
      expect(nocPerms).toEqual(['perm-network-manage']);
    });
  });

  describe('grant — idempotency', () => {
    it('granting the same permission twice does NOT duplicate it', async () => {
      const repo = makeRepo();
      await repo.grant('role-admin', 'perm-clients-read');
      await repo.grant('role-admin', 'perm-clients-read'); // duplicate — must be no-op
      const permIds = await repo.listForRole('role-admin');
      expect(permIds).toHaveLength(1);
      expect(permIds[0]).toBe('perm-clients-read');
    });

    it('does not throw on duplicate grant', async () => {
      const repo = makeRepo();
      await repo.grant('role-admin', 'perm-clients-read');
      await expect(repo.grant('role-admin', 'perm-clients-read')).resolves.toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('removes the permission from the role', async () => {
      const repo = makeRepo();
      await repo.grant('role-admin', 'perm-clients-read');
      await repo.revoke('role-admin', 'perm-clients-read');
      const permIds = await repo.listForRole('role-admin');
      expect(permIds).toHaveLength(0);
    });

    it('only removes the targeted permission, not others', async () => {
      const repo = makeRepo();
      await repo.grant('role-admin', 'perm-clients-read');
      await repo.grant('role-admin', 'perm-billing-write');
      await repo.revoke('role-admin', 'perm-clients-read');
      const permIds = await repo.listForRole('role-admin');
      expect(permIds).toEqual(['perm-billing-write']);
    });

    it('is a no-op when the grant does not exist', async () => {
      const repo = makeRepo();
      await expect(repo.revoke('role-admin', 'perm-nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('listForRole', () => {
    it('returns empty array for a role with no permission grants', async () => {
      const repo = makeRepo();
      const permIds = await repo.listForRole('role-without-perms');
      expect(permIds).toEqual([]);
    });
  });
}
