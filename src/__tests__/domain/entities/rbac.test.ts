/**
 * Phase 1.1 / Phase 2.4 — Entity shape tests for RBAC domain types.
 * Phase 2: updated to assert 25 modules and 28 known actions.
 */
import {
  PermissionAction,
  RbacModuleCode,
  SystemRoleCode,
  RBAC_MODULES,
  SYSTEM_ROLES,
  KNOWN_ACTIONS,
  RbacUser,
  RbacRole,
  RbacModule,
  RbacPermission,
  RbacUserRole,
  RbacRolePermission,
} from '../../../domain/entities/rbac';

describe('RBAC_MODULES constant', () => {
  it('contains exactly 25 module codes (14 original + 11 new from Phase 2)', () => {
    expect(RBAC_MODULES).toHaveLength(25);
  });

  it('includes all 14 original module codes', () => {
    const original = [
      'clients', 'billing', 'scheduling', 'network', 'admin', 'monitoring',
      'iclass', 'gestionReal', 'reports', 'tickets', 'settings', 'crm',
      'inventory', 'vehicles',
    ];
    for (const code of original) {
      expect(RBAC_MODULES).toContain(code);
    }
  });

  it('includes all 11 new Phase 2 module codes', () => {
    const newModules = [
      'voices', 'partners', 'rbac', 'profile', 'notifications',
      'dashboard', 'portal', 'search', 'support', 'sla', 'tariffs',
    ];
    for (const code of newModules) {
      expect(RBAC_MODULES).toContain(code);
    }
  });

  it('is readonly (as const)', () => {
    // Type-level check: RbacModuleCode is a union of the 25 values
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
  it('accepts all 4 base action strings', () => {
    const actions: PermissionAction[] = ['read', 'write', 'delete', 'manage'];
    expect(actions).toHaveLength(4);
    expect(actions).toContain('read');
    expect(actions).toContain('write');
    expect(actions).toContain('delete');
    expect(actions).toContain('manage');
  });
});

describe('KNOWN_ACTIONS constant', () => {
  it('contains exactly 28 valid action codes (4 base + 24 sub-actions)', () => {
    expect(KNOWN_ACTIONS).toHaveLength(28);
  });

  it('includes all 4 base actions', () => {
    expect(KNOWN_ACTIONS).toContain('read');
    expect(KNOWN_ACTIONS).toContain('write');
    expect(KNOWN_ACTIONS).toContain('delete');
    expect(KNOWN_ACTIONS).toContain('manage');
  });

  it('includes all 24 sub-action codes from spec', () => {
    const subActions = [
      // tickets
      'close', 'reopen',
      // billing
      'void', 'send_email',
      // scheduling
      'send_to_iclass', 'bulk_delete', 'move_stage', 'manage_checklist',
      // monitoring
      'acknowledge_alert',
      // network
      'manage_gpon', 'manage_sites',
      // iclass
      'sync', 'assign_to_project',
      // clients
      'manage_documents', 'manage_online_sessions',
      // admin
      'view_activity_log', 'manage_2fa',
      // rbac
      'manage_users', 'manage_user_roles', 'change_user_password', 'manage_roles',
      // profile
      'change_own_password',
      // settings
      'manage_api_tokens', 'manage_backups',
    ];
    expect(subActions).toHaveLength(24);
    for (const action of subActions) {
      expect(KNOWN_ACTIONS).toContain(action);
    }
  });

  it('is exported as KNOWN_ACTIONS (source-of-truth for valid action codes)', () => {
    // TS-level: KNOWN_ACTIONS[number] = PermissionAction
    const action: PermissionAction = 'close';
    expect(action).toBe('close');
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
