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
import { RoleCodeTakenError } from '@domain/errors/rbacUser.errors';

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

  describe('create', () => {
    it('returns the created role with a new id and correct fields', async () => {
      const repo = await makeSeededRepo();
      const role = await repo.create({
        code: 'custom_role',
        label: 'Custom Role',
        description: 'A custom role for testing',
        isSystem: false,
      });
      expect(typeof role.id).toBe('string');
      expect(role.id.length).toBeGreaterThan(0);
      expect(role.code).toBe('custom_role');
      expect(role.label).toBe('Custom Role');
      expect(role.isSystem).toBe(false);
    });

    it('created role is findable by id', async () => {
      const repo = await makeSeededRepo();
      const created = await repo.create({
        code: 'findable_role',
        label: 'Findable Role',
        isSystem: false,
      });
      const found = await repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.code).toBe('findable_role');
    });

    it('throws RoleCodeTakenError on duplicate code', async () => {
      const repo = await makeSeededRepo();
      await repo.create({ code: 'dup_code', label: 'Dup Role', isSystem: false });
      await expect(
        repo.create({ code: 'dup_code', label: 'Another Role', isSystem: false }),
      ).rejects.toThrow(RoleCodeTakenError);
    });

    it('duplicate code error has code ROLE_CODE_TAKEN', async () => {
      const repo = await makeSeededRepo();
      await repo.create({ code: 'dup_code2', label: 'Dup Role 2', isSystem: false });
      try {
        await repo.create({ code: 'dup_code2', label: 'Another Role', isSystem: false });
        fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe('ROLE_CODE_TAKEN');
      }
    });
  });

  describe('delete', () => {
    it('returns true when role exists and removes it', async () => {
      const repo = await makeSeededRepo();
      const role = await repo.create({ code: 'deletable_role', label: 'Deletable', isSystem: false });
      const result = await repo.delete(role.id);
      expect(result).toBe(true);
      const found = await repo.findById(role.id);
      expect(found).toBeNull();
    });

    it('returns false when role does not exist', async () => {
      const repo = await makeSeededRepo();
      const result = await repo.delete('non-existent-id-xyz');
      expect(result).toBe(false);
    });
  });
}
