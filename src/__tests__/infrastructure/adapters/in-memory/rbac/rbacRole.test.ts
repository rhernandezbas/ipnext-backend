/**
 * Contract tests for InMemoryRbacRoleRepository.
 *
 * Delegates to the shared contract suite, which is also run against
 * PrismaRbacRoleRepository (skip-gated when DATABASE_URL_TEST is absent).
 *
 * The InMemory repo needs a seed factory since roles are catalog data —
 * pre-seeded via migration SQL in the Prisma path.
 */
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { runRbacRoleContractTests } from '../../_shared/rbacRoleContractTests';

describe('InMemoryRbacRoleRepository', () => {
  runRbacRoleContractTests(async () => {
    const repo = new InMemoryRbacRoleRepository();
    await repo.create({ code: 'noc', label: 'NOC', isSystem: true });
    await repo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    await repo.create({ code: 'admin', label: 'Admin', isSystem: true });
    await repo.create({ code: 'viewer', label: 'Viewer', isSystem: false });
    return repo;
  });

  // Extra tests that cover InMemory-specific behavior (generate unique ids, etc.)
  describe('create (InMemory extra checks)', () => {
    it('generates unique ids for distinct roles', async () => {
      const repo = new InMemoryRbacRoleRepository();
      const r1 = await repo.create({ code: 'r1', label: 'Role 1', isSystem: false });
      const r2 = await repo.create({ code: 'r2', label: 'Role 2', isSystem: false });
      expect(r1.id).not.toBe(r2.id);
    });

    it('finds a role by id after creation', async () => {
      const repo = new InMemoryRbacRoleRepository();
      const role = await repo.create({ code: 'noc', label: 'NOC', isSystem: true });
      const found = await repo.findById(role.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(role.id);
      expect(found!.code).toBe('noc');
      expect(found!.label).toBe('NOC');
      expect(found!.isSystem).toBe(true);
    });

    it('returns all created roles', async () => {
      const repo = new InMemoryRbacRoleRepository();
      await repo.create({ code: 'admin', label: 'Admin', isSystem: true });
      await repo.create({ code: 'viewer', label: 'Viewer', isSystem: false });
      const roles = await repo.listAll();
      expect(roles).toHaveLength(2);
      expect(roles.map(r => r.code)).toContain('admin');
      expect(roles.map(r => r.code)).toContain('viewer');
    });

    it('returns an empty array when no roles exist', async () => {
      const repo = new InMemoryRbacRoleRepository();
      const roles = await repo.listAll();
      expect(Array.isArray(roles)).toBe(true);
    });
  });
});
