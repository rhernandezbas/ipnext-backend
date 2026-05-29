/**
 * Shared contract tests for RbacRoleRepository.
 *
 * The factory `makeRepo` must return a repo pre-seeded with at least
 * { code: 'noc', label: 'NOC', isSystem: true } and
 * { code: 'super_admin', label: 'Super Admin', isSystem: true }.
 * InMemory adapter seeds via its create() helper; Prisma adapter relies on
 * migration seed data (and wraps the Prisma adapter in a skip guard).
 */
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';

/**
 * `makeSeededRepo` must return a repo that already contains:
 *   - role with code 'noc', label 'NOC', isSystem true
 *   - role with code 'super_admin', label 'Super Admin', isSystem true
 */
export function runRbacRoleContractTests(makeSeededRepo: () => Promise<RbacRoleRepository>): void {
  describe('listAll', () => {
    it('returns a non-empty array of roles', async () => {
      const repo = await makeSeededRepo();
      const roles = await repo.listAll();
      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
    });

    it('returned roles have the expected shape', async () => {
      const repo = await makeSeededRepo();
      const roles = await repo.listAll();
      for (const role of roles) {
        expect(typeof role.id).toBe('string');
        expect(typeof role.code).toBe('string');
        expect(typeof role.label).toBe('string');
        expect(typeof role.isSystem).toBe('boolean');
      }
    });
  });

  describe('findById', () => {
    it('returns null for an unknown id', async () => {
      const repo = await makeSeededRepo();
      const result = await repo.findById('nonexistent-id');
      expect(result).toBeNull();
    });

    it('finds a role by id', async () => {
      const repo = await makeSeededRepo();
      const all = await repo.listAll();
      const first = all[0];
      const found = await repo.findById(first.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(first.id);
      expect(found!.code).toBe(first.code);
    });
  });

  describe('findByCode', () => {
    it('returns null for an unknown code', async () => {
      const repo = await makeSeededRepo();
      const result = await repo.findByCode('ghost');
      expect(result).toBeNull();
    });

    it('finds a role by code', async () => {
      const repo = await makeSeededRepo();
      const result = await repo.findByCode('super_admin');
      expect(result).not.toBeNull();
      expect(result!.code).toBe('super_admin');
    });

    it('returns correct label and isSystem flag', async () => {
      const repo = await makeSeededRepo();
      const result = await repo.findByCode('noc');
      expect(result).not.toBeNull();
      expect(result!.isSystem).toBe(true);
    });
  });
}
