/**
 * Tests for SetRolePermissions use case.
 *
 * SDD #3 Phase 4a — PUT /api/admin/rbac/roles/:id/permissions
 * Uses InMemory adapters.
 */
import { SetRolePermissions } from '@application/use-cases/rbac/SetRolePermissions';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';

async function buildFixture() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const useCase = new SetRolePermissions(roleRepo, rolePermRepo, permRepo);
  return { roleRepo, rolePermRepo, permRepo, useCase };
}

describe('SetRolePermissions', () => {
  it('replaces permissions for a role and returns the new permissionIds', async () => {
    const { roleRepo, rolePermRepo, permRepo, useCase } = await buildFixture();

    const role = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
    const permA = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
    const permB = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });
    const permC = await permRepo.seed({ moduleCode: 'scheduling', action: 'delete' });
    const permD = await permRepo.seed({ moduleCode: 'billing', action: 'read' });

    // Initial grant A, B, C
    await rolePermRepo.grant(role.id, permA.id);
    await rolePermRepo.grant(role.id, permB.id);
    await rolePermRepo.grant(role.id, permC.id);

    // Replace with B, D
    const result = await useCase.execute(role.id, [permB.id, permD.id]);

    expect(result).toHaveLength(2);
    expect(result).toContain(permB.id);
    expect(result).toContain(permD.id);
    expect(result).not.toContain(permA.id);
    expect(result).not.toContain(permC.id);
  });

  it('clears all grants when permissionIds=[]', async () => {
    const { roleRepo, rolePermRepo, permRepo, useCase } = await buildFixture();

    const role = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });
    const perm = await permRepo.seed({ moduleCode: 'crm', action: 'read' });
    await rolePermRepo.grant(role.id, perm.id);

    const result = await useCase.execute(role.id, []);

    expect(result).toEqual([]);
  });

  it('is idempotent — calling twice with same IDs returns same result', async () => {
    const { roleRepo, permRepo, useCase } = await buildFixture();

    const role = await roleRepo.create({ code: 'noc', label: 'NOC', isSystem: true });
    const permA = await permRepo.seed({ moduleCode: 'monitoring', action: 'read' });
    const permB = await permRepo.seed({ moduleCode: 'monitoring', action: 'manage' });

    const result1 = await useCase.execute(role.id, [permA.id, permB.id]);
    const result2 = await useCase.execute(role.id, [permA.id, permB.id]);

    expect(result1.sort()).toEqual(result2.sort());
    expect(result2).toHaveLength(2);
  });

  it('throws SUPER_ADMIN_IMMUTABLE when role.code === "super_admin"', async () => {
    const { roleRepo, permRepo, useCase } = await buildFixture();

    const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    const perm = await permRepo.seed({ moduleCode: 'rbac', action: 'manage_roles' });

    await expect(useCase.execute(superAdminRole.id, [perm.id])).rejects.toMatchObject({
      code: 'SUPER_ADMIN_IMMUTABLE',
    });
  });

  it('throws ROLE_NOT_FOUND for unknown roleId', async () => {
    const { useCase } = await buildFixture();

    await expect(useCase.execute('non-existent-id', [])).rejects.toMatchObject({
      code: 'ROLE_NOT_FOUND',
    });
  });

  it('throws INVALID_PERMISSION_IDS when any permissionId does not exist in catalog', async () => {
    const { roleRepo, permRepo, useCase } = await buildFixture();

    const role = await roleRepo.create({ code: 'administrador', label: 'Administrador', isSystem: true });
    const validPerm = await permRepo.seed({ moduleCode: 'billing', action: 'read' });

    await expect(
      useCase.execute(role.id, [validPerm.id, 'fake-perm-id-1', 'fake-perm-id-2']),
    ).rejects.toMatchObject({
      code: 'INVALID_PERMISSION_IDS',
    });
  });
});
