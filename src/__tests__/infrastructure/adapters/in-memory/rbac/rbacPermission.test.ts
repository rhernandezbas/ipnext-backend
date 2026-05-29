/**
 * Contract tests for InMemoryRbacPermissionRepository.
 *
 * Delegates to the shared contract suite, which is also run against
 * PrismaRbacPermissionRepository (skip-gated when DATABASE_URL_TEST is absent).
 *
 * The InMemory repo needs a seed factory since permissions are catalog data —
 * pre-seeded via migration SQL in the Prisma path.
 */
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { runRbacPermissionContractTests } from '../../_shared/rbacPermissionContractTests';

describe('InMemoryRbacPermissionRepository', () => {
  runRbacPermissionContractTests(async () => {
    const repo = new InMemoryRbacPermissionRepository();
    await repo.seed({ moduleCode: 'network', action: 'read' });
    await repo.seed({ moduleCode: 'clients', action: 'read' });
    await repo.seed({ moduleCode: 'billing', action: 'write' });
    await repo.seed({ moduleCode: 'scheduling', action: 'manage' });
    return repo;
  });

  // Extra tests that cover seed() helper, which is InMemory-specific
  // and not part of the port (Prisma populates permissions via migration SQL)
  describe('seed helper (InMemory-only)', () => {
    it('generates unique ids for each permission', async () => {
      const repo = new InMemoryRbacPermissionRepository();
      const p1 = await repo.seed({ moduleCode: 'clients', action: 'read' });
      const p2 = await repo.seed({ moduleCode: 'clients', action: 'write' });
      expect(p1.id).not.toBe(p2.id);
    });

    it('returned permission has correct shape', async () => {
      const repo = new InMemoryRbacPermissionRepository();
      const perm = await repo.seed({ moduleCode: 'scheduling', action: 'manage' });
      expect(perm.id).toBeDefined();
      expect(perm.moduleCode).toBe('scheduling');
      expect(perm.action).toBe('manage');
    });

    it('returns an empty array when no permissions exist', async () => {
      const repo = new InMemoryRbacPermissionRepository();
      const perms = await repo.listAll();
      expect(perms).toEqual([]);
    });

    it('returns all seeded permissions', async () => {
      const repo = new InMemoryRbacPermissionRepository();
      await repo.seed({ moduleCode: 'clients', action: 'read' });
      await repo.seed({ moduleCode: 'billing', action: 'write' });
      const perms = await repo.listAll();
      expect(perms).toHaveLength(2);
      expect(perms.map(p => p.moduleCode)).toContain('clients');
      expect(perms.map(p => p.moduleCode)).toContain('billing');
    });
  });
});
