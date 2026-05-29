/**
 * Tests for ResolveUserPermissions use case.
 *
 * Uses InMemory adapters. Validates the spec scenarios S1–S7 from
 * openspec/changes/roles-permissions-management/specs/rbac-effective-permissions/spec.md
 */
import { ResolveUserPermissions } from '@application/use-cases/rbac/ResolveUserPermissions';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import type { RbacRole } from '@domain/entities/rbac';

async function buildFixture() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository(roleRepo);
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const permRepo = new InMemoryRbacPermissionRepository();

  const useCase = new ResolveUserPermissions(userRoleRepo, rolePermRepo, permRepo);

  return { roleRepo, userRoleRepo, rolePermRepo, permRepo, useCase };
}

describe('ResolveUserPermissions', () => {
  // S1: super_admin short-circuit
  it('S1: user with role code=super_admin → returns ["*"]', async () => {
    const { roleRepo, userRoleRepo, rolePermRepo, permRepo, useCase } = await buildFixture();

    const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
    await userRoleRepo.assign('user-1', superAdminRole.id);

    // Spy on permRepo.listAll to confirm it is NOT called (short-circuit)
    const listAllSpy = jest.spyOn(permRepo, 'listAll');

    const result = await useCase.execute('user-1');

    expect(result).toEqual(['*']);
    expect(listAllSpy).not.toHaveBeenCalled();

    listAllSpy.mockRestore();
  });

  // S2: single role with permissions
  it('S2: user with role "tecnico" having [scheduling.read, scheduling.write] → returns those codes', async () => {
    const { roleRepo, userRoleRepo, rolePermRepo, permRepo, useCase } = await buildFixture();

    const role = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
    await userRoleRepo.assign('user-1', role.id);

    const permA = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
    const permB = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });

    await rolePermRepo.grant(role.id, permA.id);
    await rolePermRepo.grant(role.id, permB.id);

    const result = await useCase.execute('user-1');

    expect(result).toHaveLength(2);
    expect(result).toContain('scheduling.read');
    expect(result).toContain('scheduling.write');
  });

  // S3: multiple roles, union deduplicated
  it('S3: user with roles [noc, tecnico] having overlapping scheduling.read → returns 5 codes deduplicated', async () => {
    const { roleRepo, userRoleRepo, rolePermRepo, permRepo, useCase } = await buildFixture();

    const nocRole = await roleRepo.create({ code: 'noc', label: 'NOC', isSystem: true });
    const tecRole = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
    await userRoleRepo.assign('user-1', nocRole.id);
    await userRoleRepo.assign('user-1', tecRole.id);

    const monRead = await permRepo.seed({ moduleCode: 'monitoring', action: 'read' });
    const monAck = await permRepo.seed({ moduleCode: 'monitoring', action: 'manage' }); // using manage as proxy for acknowledge_alert in test
    const schedRead = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
    const schedWrite = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });
    const schedDelete = await permRepo.seed({ moduleCode: 'scheduling', action: 'delete' });

    // noc: monitoring.read, monitoring.manage, scheduling.read
    await rolePermRepo.grant(nocRole.id, monRead.id);
    await rolePermRepo.grant(nocRole.id, monAck.id);
    await rolePermRepo.grant(nocRole.id, schedRead.id);

    // tecnico: scheduling.read (overlap), scheduling.write, scheduling.delete
    await rolePermRepo.grant(tecRole.id, schedRead.id);
    await rolePermRepo.grant(tecRole.id, schedWrite.id);
    await rolePermRepo.grant(tecRole.id, schedDelete.id);

    const result = await useCase.execute('user-1');

    // 5 unique codes
    expect(result).toHaveLength(5);
    expect(result).toContain('monitoring.read');
    expect(result).toContain('monitoring.manage');
    expect(result).toContain('scheduling.read');
    expect(result).toContain('scheduling.write');
    expect(result).toContain('scheduling.delete');
  });

  // S4: user with no roles
  it('S4: user with no roles → returns []', async () => {
    const { useCase } = await buildFixture();
    const result = await useCase.execute('user-no-roles');
    expect(result).toEqual([]);
  });

  // S5: user with roles but zero permissions granted
  it('S5: user with role "ventas" with no permissions granted → returns []', async () => {
    const { roleRepo, userRoleRepo, useCase } = await buildFixture();

    const role = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });
    await userRoleRepo.assign('user-1', role.id);

    const result = await useCase.execute('user-1');
    expect(result).toEqual([]);
  });

  // S6: invalid userId (empty string)
  it('S6: userId="" → throws ValidationError with code INVALID_USER_ID', async () => {
    const { useCase } = await buildFixture();
    await expect(useCase.execute('')).rejects.toMatchObject({ code: 'INVALID_USER_ID' });
  });

  // S7: permission code format
  it('S7: permission code format is moduleCode.action (e.g. scheduling.delete)', async () => {
    const { roleRepo, userRoleRepo, rolePermRepo, permRepo, useCase } = await buildFixture();

    const role = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
    await userRoleRepo.assign('user-1', role.id);

    const perm = await permRepo.seed({ moduleCode: 'scheduling', action: 'delete' });
    await rolePermRepo.grant(role.id, perm.id);

    const result = await useCase.execute('user-1');

    expect(result).toContain('scheduling.delete');
  });
});
