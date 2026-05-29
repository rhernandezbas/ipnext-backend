/**
 * Tests for ListAllPermissionsWithModule use case.
 *
 * SDD #3 Phase 4a — GET /api/admin/rbac/permissions catalog endpoint.
 * Uses InMemory adapters.
 */
import { ListAllPermissionsWithModule } from '@application/use-cases/rbac/ListAllPermissionsWithModule';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';

describe('ListAllPermissionsWithModule', () => {
  it('returns all permissions with moduleCode, action', async () => {
    const permRepo = new InMemoryRbacPermissionRepository();
    await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
    await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });
    await permRepo.seed({ moduleCode: 'billing', action: 'read' });

    const useCase = new ListAllPermissionsWithModule(permRepo);
    const result = await useCase.execute();

    expect(result).toHaveLength(3);
    expect(result.every(p => p.id && p.moduleCode && p.action)).toBe(true);
  });

  it('returns empty array when no permissions exist', async () => {
    const permRepo = new InMemoryRbacPermissionRepository();
    const useCase = new ListAllPermissionsWithModule(permRepo);
    const result = await useCase.execute();
    expect(result).toEqual([]);
  });

  it('each result has shape { id, moduleCode, action }', async () => {
    const permRepo = new InMemoryRbacPermissionRepository();
    const perm = await permRepo.seed({ moduleCode: 'rbac', action: 'manage_roles' });
    const useCase = new ListAllPermissionsWithModule(permRepo);
    const result = await useCase.execute();

    expect(result[0]).toMatchObject({
      id: perm.id,
      moduleCode: 'rbac',
      action: 'manage_roles',
    });
  });

  it('enriches each entry with the module id and label', async () => {
    const permRepo = new InMemoryRbacPermissionRepository();
    await permRepo.seed({
      moduleCode: 'rbac',
      action: 'manage_roles',
      moduleId: 'mod-rbac',
      moduleLabel: 'Roles y Permisos',
    });
    const useCase = new ListAllPermissionsWithModule(permRepo);
    const result = await useCase.execute();

    expect(result[0]).toMatchObject({
      moduleId: 'mod-rbac',
      moduleCode: 'rbac',
      moduleLabel: 'Roles y Permisos',
      action: 'manage_roles',
    });
  });

  it('falls back moduleLabel to the moduleCode when no label was seeded', async () => {
    const permRepo = new InMemoryRbacPermissionRepository();
    await permRepo.seed({ moduleCode: 'billing', action: 'read' });
    const useCase = new ListAllPermissionsWithModule(permRepo);
    const result = await useCase.execute();

    expect(result[0].moduleLabel).toBe('billing');
    expect(typeof result[0].moduleId).toBe('string');
    expect(result[0].moduleId.length).toBeGreaterThan(0);
  });
});
