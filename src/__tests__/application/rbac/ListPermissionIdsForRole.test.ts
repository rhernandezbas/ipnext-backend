/**
 * Tests for ListPermissionIdsForRole use case.
 *
 * SDD #3 Phase 4a — GET /api/admin/rbac/roles/:id/permissions
 * Uses InMemory adapters.
 */
import { ListPermissionIdsForRole } from '@application/use-cases/rbac/ListPermissionIdsForRole';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';

describe('ListPermissionIdsForRole', () => {
  it('returns permissionIds for a role that has 2 permissions', async () => {
    const roleRepo = new InMemoryRbacRoleRepository();
    const rolePermRepo = new InMemoryRbacRolePermissionRepository();
    const permRepo = new InMemoryRbacPermissionRepository();

    const role = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
    const permA = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
    const permB = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });
    await rolePermRepo.grant(role.id, permA.id);
    await rolePermRepo.grant(role.id, permB.id);

    const useCase = new ListPermissionIdsForRole(roleRepo, rolePermRepo);
    const result = await useCase.execute(role.id);

    expect(result).toHaveLength(2);
    expect(result).toContain(permA.id);
    expect(result).toContain(permB.id);
  });

  it('returns [] for a role with no permissions', async () => {
    const roleRepo = new InMemoryRbacRoleRepository();
    const rolePermRepo = new InMemoryRbacRolePermissionRepository();

    const role = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });

    const useCase = new ListPermissionIdsForRole(roleRepo, rolePermRepo);
    const result = await useCase.execute(role.id);

    expect(result).toEqual([]);
  });

  it('throws ROLE_NOT_FOUND for unknown roleId', async () => {
    const roleRepo = new InMemoryRbacRoleRepository();
    const rolePermRepo = new InMemoryRbacRolePermissionRepository();

    const useCase = new ListPermissionIdsForRole(roleRepo, rolePermRepo);

    await expect(useCase.execute('non-existent-id')).rejects.toMatchObject({
      code: 'ROLE_NOT_FOUND',
    });
  });
});
