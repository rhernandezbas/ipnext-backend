/**
 * Phase 1.3 — RED: Compile-time shape contracts for all 5 RBAC port interfaces.
 *
 * These tests use inline stub objects typed as the port interfaces.
 * If the interface definition changes shape (method added/removed/renamed),
 * TypeScript compilation fails — making any mis-implementation immediately visible.
 *
 * No InMemory adapters are imported here (those come in Phase 2).
 * The test runner validates the contracts via ts-jest.
 */

import {
  RbacUserRepository,
  CreateRbacUserInput,
  UpdateRbacUserInput,
} from '../../../domain/ports/RbacUserRepository';
import { RbacRoleRepository } from '../../../domain/ports/RbacRoleRepository';
import { RbacPermissionRepository } from '../../../domain/ports/RbacPermissionRepository';
import { RbacUserRoleRepository } from '../../../domain/ports/RbacUserRoleRepository';
import { RbacRolePermissionRepository } from '../../../domain/ports/RbacRolePermissionRepository';
import type { RbacUser, RbacRole, RbacPermission } from '../../../domain/entities/rbac';

// ---------------------------------------------------------------------------
// Helpers — minimal stub factories so that TypeScript accepts the assignments.
// These are never executed at runtime; the compile step IS the test.
// ---------------------------------------------------------------------------

function makeUser(): RbacUser {
  return {
    id: 'u-1',
    name: 'Test User',
    email: 'test@example.com',
    login: 'testuser',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
  };
}

function makeRole(): RbacRole {
  return { id: 'r-1', code: 'noc', label: 'NOC', isSystem: true };
}

function makePermission(): RbacPermission {
  return { id: 'p-1', moduleCode: 'network', action: 'read' };
}

// ---------------------------------------------------------------------------
// RbacUserRepository contract
// ---------------------------------------------------------------------------

describe('RbacUserRepository — interface contract', () => {
  it('stub satisfies the full interface shape', () => {
    // Create an inline stub that satisfies the interface.
    // TypeScript will error at compile time if the interface shape changes.
    const stub: RbacUserRepository = {
      findById: async (_id: string) => makeUser(),
      findByLogin: async (_login: string) => ({ ...makeUser(), passwordHash: 'hash' }),
      findByEmail: async (_email: string) => makeUser(),
      create: async (_input: CreateRbacUserInput) => makeUser(),
      updateLastLogin: async (_id: string, _at: Date) => { /* void */ },
      listRolesForUser: async (_userId: string) => [makeRole()],
      listPermissionsForUser: async (_userId: string) => [makePermission()],
      // SDD #2 additions
      list: async () => [makeUser()],
      update: async (_id: string, _patch: UpdateRbacUserInput) => makeUser(),
      delete: async (_id: string) => { /* void */ },
      countUsersWithRoleCode: async (_roleCode: string) => 0,
    };

    // Verify the stub is a defined object (exercises the assignment above).
    expect(stub).toBeDefined();
    expect(typeof stub.findById).toBe('function');
    expect(typeof stub.findByLogin).toBe('function');
    expect(typeof stub.findByEmail).toBe('function');
    expect(typeof stub.create).toBe('function');
    expect(typeof stub.updateLastLogin).toBe('function');
    expect(typeof stub.listRolesForUser).toBe('function');
    expect(typeof stub.listPermissionsForUser).toBe('function');
    expect(typeof stub.list).toBe('function');
    expect(typeof stub.update).toBe('function');
    expect(typeof stub.delete).toBe('function');
    expect(typeof stub.countUsersWithRoleCode).toBe('function');
  });

  it('findById stub returns a user or null', async () => {
    const stub: RbacUserRepository = {
      findById: async (id: string) => (id === 'u-1' ? makeUser() : null),
      findByLogin: async () => null,
      findByEmail: async () => null,
      create: async (_input: CreateRbacUserInput) => makeUser(),
      updateLastLogin: async () => { /* void */ },
      listRolesForUser: async () => [],
      listPermissionsForUser: async () => [],
      list: async () => [],
      update: async () => makeUser(),
      delete: async () => { /* void */ },
      countUsersWithRoleCode: async () => 0,
    };
    const found = await stub.findById('u-1');
    const missing = await stub.findById('ghost');
    expect(found?.id).toBe('u-1');
    expect(missing).toBeNull();
  });

  it('findByLogin stub returns extended user with passwordHash or null', async () => {
    const stub: RbacUserRepository = {
      findById: async () => null,
      findByLogin: async (login: string) =>
        login === 'jdoe' ? { ...makeUser(), login: 'jdoe', passwordHash: 'hashed' } : null,
      findByEmail: async () => null,
      create: async (_input: CreateRbacUserInput) => makeUser(),
      updateLastLogin: async () => { /* void */ },
      listRolesForUser: async () => [],
      listPermissionsForUser: async () => [],
      list: async () => [],
      update: async () => makeUser(),
      delete: async () => { /* void */ },
      countUsersWithRoleCode: async () => 0,
    };
    const found = await stub.findByLogin('jdoe');
    const missing = await stub.findByLogin('ghost');
    expect(found?.passwordHash).toBe('hashed');
    expect(missing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RbacRoleRepository contract
// ---------------------------------------------------------------------------

describe('RbacRoleRepository — interface contract', () => {
  it('stub satisfies the full interface shape', () => {
    const stub: RbacRoleRepository = {
      findById: async (_id: string) => makeRole(),
      findByCode: async (_code: string) => makeRole(),
      listAll: async () => [makeRole()],
      create: async () => makeRole(),
      delete: async () => true,
    };
    expect(stub).toBeDefined();
    expect(typeof stub.findById).toBe('function');
    expect(typeof stub.findByCode).toBe('function');
    expect(typeof stub.listAll).toBe('function');
    expect(typeof stub.create).toBe('function');
    expect(typeof stub.delete).toBe('function');
  });

  it('findByCode returns null for unknown code', async () => {
    const stub: RbacRoleRepository = {
      findById: async () => null,
      findByCode: async (code: string) => (code === 'noc' ? makeRole() : null),
      listAll: async () => [],
      create: async () => makeRole(),
      delete: async () => false,
    };
    const found = await stub.findByCode('noc');
    const missing = await stub.findByCode('ghost');
    expect(found?.code).toBe('noc');
    expect(missing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RbacPermissionRepository contract
// ---------------------------------------------------------------------------

describe('RbacPermissionRepository — interface contract', () => {
  it('stub satisfies the full interface shape', () => {
    const stub: RbacPermissionRepository = {
      listAll: async () => [makePermission()],
      findByModuleAndAction: async (_mod: string, _action: string) => makePermission(),
    };
    expect(stub).toBeDefined();
    expect(typeof stub.listAll).toBe('function');
    expect(typeof stub.findByModuleAndAction).toBe('function');
  });

  it('listAll returns array of permissions', async () => {
    const stub: RbacPermissionRepository = {
      listAll: async () => [makePermission()],
      findByModuleAndAction: async () => null,
    };
    const all = await stub.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].moduleCode).toBe('network');
  });
});

// ---------------------------------------------------------------------------
// RbacUserRoleRepository contract
// ---------------------------------------------------------------------------

describe('RbacUserRoleRepository — interface contract', () => {
  it('stub satisfies the full interface shape', () => {
    const stub: RbacUserRoleRepository = {
      assign: async (_userId: string, _roleId: string) => { /* void */ },
      revoke: async (_userId: string, _roleId: string) => { /* void */ },
      listForUser: async (_userId: string) => ['r-1'],
      listRolesForUser: async (_userId: string) => [],
    };
    expect(stub).toBeDefined();
    expect(typeof stub.assign).toBe('function');
    expect(typeof stub.revoke).toBe('function');
    expect(typeof stub.listForUser).toBe('function');
    expect(typeof stub.listRolesForUser).toBe('function');
  });

  it('listForUser returns empty array for user with no roles', async () => {
    const stub: RbacUserRoleRepository = {
      assign: async () => { /* void */ },
      revoke: async () => { /* void */ },
      listForUser: async (userId: string) => (userId === 'u-with-role' ? ['r-1'] : []),
      listRolesForUser: async () => [],
    };
    const roles = await stub.listForUser('u-no-roles');
    const withRoles = await stub.listForUser('u-with-role');
    expect(roles).toHaveLength(0);
    expect(withRoles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RbacRolePermissionRepository contract
// ---------------------------------------------------------------------------

describe('RbacRolePermissionRepository — interface contract', () => {
  it('stub satisfies the full interface shape', () => {
    const stub: RbacRolePermissionRepository = {
      grant: async (_roleId: string, _permissionId: string) => { /* void */ },
      revoke: async (_roleId: string, _permissionId: string) => { /* void */ },
      listForRole: async (_roleId: string) => ['p-1'],
      replaceForRole: async (_roleId: string, _permissionIds: string[]) => { /* void */ },
    };
    expect(stub).toBeDefined();
    expect(typeof stub.grant).toBe('function');
    expect(typeof stub.revoke).toBe('function');
    expect(typeof stub.listForRole).toBe('function');
    expect(typeof stub.replaceForRole).toBe('function');
  });

  it('listForRole returns empty array for role with no permissions', async () => {
    const stub: RbacRolePermissionRepository = {
      grant: async () => { /* void */ },
      revoke: async () => { /* void */ },
      listForRole: async (roleId: string) => (roleId === 'r-with-perms' ? ['p-1'] : []),
      replaceForRole: async () => { /* void */ },
    };
    const empty = await stub.listForRole('r-no-perms');
    const withPerms = await stub.listForRole('r-with-perms');
    expect(empty).toHaveLength(0);
    expect(withPerms).toHaveLength(1);
  });
});
