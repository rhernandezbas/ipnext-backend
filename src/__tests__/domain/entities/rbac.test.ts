/**
 * Phase 1.1 — RED: Entity shape tests for RBAC domain types.
 * These tests fail until rbac.ts is created (Task 1.2).
 */
import {
  PermissionAction,
  RbacModuleCode,
  SystemRoleCode,
  RBAC_MODULES,
  SYSTEM_ROLES,
  RbacUser,
  RbacRole,
  RbacModule,
  RbacPermission,
  RbacUserRole,
  RbacRolePermission,
} from '../../../domain/entities/rbac';

describe('RBAC_MODULES constant', () => {
  it('contains exactly 14 module codes', () => {
    expect(RBAC_MODULES).toHaveLength(14);
  });

  it('includes all expected module codes', () => {
    const expected = [
      'clients', 'billing', 'scheduling', 'network', 'admin', 'monitoring',
      'iclass', 'gestionReal', 'reports', 'tickets', 'settings', 'crm',
      'inventory', 'vehicles',
    ];
    expect([...RBAC_MODULES]).toEqual(expected);
  });

  it('is readonly (as const)', () => {
    // Type-level check: RbacModuleCode is a union of the 14 values
    const code: RbacModuleCode = 'clients';
    expect(code).toBe('clients');
  });
});

describe('SYSTEM_ROLES constant', () => {
  it('contains exactly 6 system role codes', () => {
    expect(SYSTEM_ROLES).toHaveLength(6);
  });

  it('includes all expected system role codes', () => {
    const expected = [
      'super_admin', 'administrador', 'administracion', 'ventas', 'noc', 'tecnico',
    ];
    expect([...SYSTEM_ROLES]).toEqual(expected);
  });

  it('is readonly (as const)', () => {
    const code: SystemRoleCode = 'super_admin';
    expect(code).toBe('super_admin');
  });
});

describe('PermissionAction type', () => {
  it('accepts all 4 valid action strings', () => {
    const actions: PermissionAction[] = ['read', 'write', 'delete', 'manage'];
    expect(actions).toHaveLength(4);
    expect(actions).toContain('read');
    expect(actions).toContain('write');
    expect(actions).toContain('delete');
    expect(actions).toContain('manage');
  });
});

describe('RbacUser entity shape', () => {
  it('holds all required fields without passwordHash', () => {
    const user: RbacUser = {
      id: 'u-1',
      name: 'John Doe',
      email: 'jdoe@example.com',
      login: 'jdoe',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastLoginAt: null,
    };
    expect(user.id).toBe('u-1');
    expect(user.login).toBe('jdoe');
    expect(user.status).toBe('active');
    expect(user.lastLoginAt).toBeNull();
    // passwordHash must NOT be present in domain entity
    expect('passwordHash' in user).toBe(false);
  });

  it('accepts disabled status', () => {
    const user: RbacUser = {
      id: 'u-2',
      name: 'Disabled User',
      email: 'disabled@example.com',
      login: 'disabled',
      status: 'disabled',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastLoginAt: null,
    };
    expect(user.status).toBe('disabled');
  });
});

describe('RbacRole entity shape', () => {
  it('holds all required fields', () => {
    const role: RbacRole = {
      id: 'r-1',
      code: 'super_admin',
      label: 'Super Admin',
      isSystem: true,
    };
    expect(role.code).toBe('super_admin');
    expect(role.isSystem).toBe(true);
  });

  it('accepts non-system roles', () => {
    const role: RbacRole = {
      id: 'r-2',
      code: 'custom_role',
      label: 'Custom Role',
      isSystem: false,
    };
    expect(role.isSystem).toBe(false);
  });
});

describe('RbacModule entity shape', () => {
  it('holds all required fields with typed code', () => {
    const mod: RbacModule = {
      id: 'm-1',
      code: 'clients',
      label: 'Clients',
    };
    expect(mod.code).toBe('clients');
    expect(mod.label).toBe('Clients');
  });
});

describe('RbacPermission entity shape', () => {
  it('holds id, moduleCode and action', () => {
    const perm: RbacPermission = {
      id: 'p-1',
      moduleCode: 'billing',
      action: 'read',
    };
    expect(perm.moduleCode).toBe('billing');
    expect(perm.action).toBe('read');
  });

  it('accepts manage action', () => {
    const perm: RbacPermission = {
      id: 'p-2',
      moduleCode: 'admin',
      action: 'manage',
    };
    expect(perm.action).toBe('manage');
  });
});

describe('RbacUserRole pivot entity shape', () => {
  it('holds userId and roleId', () => {
    const pivot: RbacUserRole = {
      userId: 'u-1',
      roleId: 'r-1',
    };
    expect(pivot.userId).toBe('u-1');
    expect(pivot.roleId).toBe('r-1');
  });
});

describe('RbacRolePermission pivot entity shape', () => {
  it('holds roleId and permissionId', () => {
    const pivot: RbacRolePermission = {
      roleId: 'r-1',
      permissionId: 'p-1',
    };
    expect(pivot.roleId).toBe('r-1');
    expect(pivot.permissionId).toBe('p-1');
  });
});
