/**
 * Shared contract tests for RbacUserRoleRepository.
 *
 * Call `runRbacUserRoleContractTests(makeFixture)` from both the
 * InMemory and Prisma test files.
 *
 * The factory `makeFixture` returns a fresh repo + optional role seeder.
 * For the Prisma adapter, use `describe.skip` when DATABASE_URL_TEST is absent.
 */
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRole } from '@domain/entities/rbac';

export interface RoleSeeder {
  seedRole(input: { code: string; label: string; isSystem: boolean }): Promise<RbacRole>;
}

export interface UserRoleContractFixture {
  repo: RbacUserRoleRepository;
  seeder?: RoleSeeder;
}

export function runRbacUserRoleContractTests(
  makeFixture: () => UserRoleContractFixture,
): void {
  describe('assign + listForUser roundtrip', () => {
    it('returns the role id after assignment', async () => {
      const { repo } = makeFixture();
      await repo.assign('user-1', 'role-admin');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(1);
      expect(roleIds[0]).toBe('role-admin');
    });

    it('tracks multiple roles for the same user', async () => {
      const { repo } = makeFixture();
      await repo.assign('user-1', 'role-admin');
      await repo.assign('user-1', 'role-noc');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(2);
      expect(roleIds).toContain('role-admin');
      expect(roleIds).toContain('role-noc');
    });

    it('keeps roles isolated per user', async () => {
      const { repo } = makeFixture();
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
      const { repo } = makeFixture();
      await repo.assign('user-1', 'role-admin');
      await repo.assign('user-1', 'role-admin'); // second call — must be no-op
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(1);
      expect(roleIds[0]).toBe('role-admin');
    });

    it('does not throw on duplicate assignment', async () => {
      const { repo } = makeFixture();
      await repo.assign('user-1', 'role-admin');
      await expect(repo.assign('user-1', 'role-admin')).resolves.toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('removes the role from the user', async () => {
      const { repo } = makeFixture();
      await repo.assign('user-1', 'role-admin');
      await repo.revoke('user-1', 'role-admin');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toHaveLength(0);
    });

    it('only removes the targeted role, not others', async () => {
      const { repo } = makeFixture();
      await repo.assign('user-1', 'role-admin');
      await repo.assign('user-1', 'role-noc');
      await repo.revoke('user-1', 'role-admin');
      const roleIds = await repo.listForUser('user-1');
      expect(roleIds).toEqual(['role-noc']);
    });

    it('is a no-op when the assignment does not exist', async () => {
      const { repo } = makeFixture();
      await expect(repo.revoke('user-1', 'role-admin')).resolves.toBeUndefined();
    });
  });

  describe('listForUser', () => {
    it('returns empty array for a user with no assignments', async () => {
      const { repo } = makeFixture();
      const roleIds = await repo.listForUser('user-without-roles');
      expect(roleIds).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // listRolesForUser — returns full RbacRole objects instead of just IDs
  // ---------------------------------------------------------------------------

  describe('listRolesForUser', () => {
    it('returns empty array for unknown userId', async () => {
      const { repo } = makeFixture();
      const roles = await repo.listRolesForUser('no-such-user');
      expect(roles).toEqual([]);
    });

    it('returns empty array for user with no assignments', async () => {
      const { repo } = makeFixture();
      const roles = await repo.listRolesForUser('user-no-roles');
      expect(roles).toEqual([]);
    });

    it('returns full RbacRole objects for assigned roles', async () => {
      const { repo, seeder } = makeFixture();
      if (!seeder) {
        // Skip when no seeder is provided (e.g., Prisma test without DB)
        return;
      }

      const roleA = await seeder.seedRole({ code: 'tecnico', label: 'Técnico', isSystem: true });
      const roleB = await seeder.seedRole({ code: 'noc', label: 'NOC', isSystem: true });

      await repo.assign('user-1', roleA.id);
      await repo.assign('user-1', roleB.id);

      const roles = await repo.listRolesForUser('user-1');
      expect(roles).toHaveLength(2);

      const codes = roles.map((r: RbacRole) => r.code).sort();
      expect(codes).toEqual(['noc', 'tecnico']);

      for (const r of roles) {
        expect(r).toMatchObject({
          id: expect.any(String),
          code: expect.any(String),
          label: expect.any(String),
        });
      }
    });

    it('keeps assignments isolated per user', async () => {
      const { repo, seeder } = makeFixture();
      if (!seeder) return;

      const role = await seeder.seedRole({ code: 'admin', label: 'Admin', isSystem: true });

      await repo.assign('user-1', role.id);
      // user-2 has no assignments

      const user1Roles = await repo.listRolesForUser('user-1');
      const user2Roles = await repo.listRolesForUser('user-2');

      expect(user1Roles).toHaveLength(1);
      expect(user2Roles).toHaveLength(0);
    });
  });
}
