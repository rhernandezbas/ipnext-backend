/**
 * Snapshot/type test for rbacUser.dto.ts
 *
 * RED: fails because src/application/dto/rbacUser.dto.ts does not exist yet.
 */
import { toRbacUserDto, toRbacRoleDto, toRbacUserWithRolesDto } from '@application/dto/rbacUser.dto';

describe('toRbacUserDto', () => {
  // We cast to `any` to simulate a raw entity that might accidentally carry
  // extra fields (e.g. passwordHash from a DB row). The mapper must drop them.
  const userEntity = {
    id: 'user-1',
    name: 'Alice',
    email: 'alice@example.com',
    login: 'alice',
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  };

  it('should map all expected fields', () => {
    const dto = toRbacUserDto(userEntity);
    expect(dto.id).toBe('user-1');
    expect(dto.name).toBe('Alice');
    expect(dto.email).toBe('alice@example.com');
    expect(dto.login).toBe('alice');
    expect(dto.status).toBe('active');
    expect(dto.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(dto.lastLoginAt).toBeNull();
  });

  it('should NOT include passwordHash in serialized output', () => {
    const dto = toRbacUserDto(userEntity);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('passwordHash');
    expect('passwordHash' in dto).toBe(false);
  });

  // Fase 2b — GR vendedor mapping moved out of the generic user DTO (isolated sub-page).
  it('should NOT expose grVendedorName in the generic user DTO', () => {
    const dto = toRbacUserDto({ ...userEntity, grVendedorName: 'JUAN PEREZ' } as Parameters<typeof toRbacUserDto>[0]);
    expect('grVendedorName' in dto).toBe(false);
  });
});

describe('toRbacRoleDto', () => {
  it('should map all role fields', () => {
    const role = { id: 'role-1', code: 'super_admin', label: 'Super Admin', isSystem: true };
    const dto = toRbacRoleDto(role);
    expect(dto).toEqual({ id: 'role-1', code: 'super_admin', label: 'Super Admin', isSystem: true });
  });
});

describe('toRbacUserWithRolesDto', () => {
  it('should include roles array and no passwordHash', () => {
    const user = {
      id: 'u1',
      name: 'Bob',
      email: 'bob@test.com',
      login: 'bob',
      status: 'active' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
    };
    const roles = [{ id: 'r1', code: 'admin', label: 'Admin', isSystem: true }];
    const dto = toRbacUserWithRolesDto(user, roles);

    expect(dto.roles).toHaveLength(1);
    expect(dto.roles[0].code).toBe('admin');
    const json = JSON.stringify(dto);
    expect(json).not.toContain('passwordHash');
  });
});
