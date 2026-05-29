/**
 * rbacRolePermissions.routes.test.ts — supertest integration tests for
 * GET  /api/admin/rbac/permissions  (catalog)
 * GET  /api/admin/rbac/roles/:id/permissions
 * PUT  /api/admin/rbac/roles/:id/permissions
 *
 * SDD #3 Phase 4a — role-permissions HTTP routes.
 *
 * Setup:
 *   - Full in-memory Express app with InMemory repos.
 *   - Two req.user fixtures:
 *       • superAdminUser → role code = 'super_admin' → short-circuits all requirePerm checks
 *       • noPermUser     → no roles → 403 PERMISSION_DENIED
 *   - Auth middleware bypassed by injecting req.user via x-test-user-id header.
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createRolePermissionsRouter } from '@infrastructure/http/routes/rolePermissions.routes';
import { createPermissionsRouter } from '@infrastructure/http/routes/permissions.routes';

import { ListAllPermissionsWithModule } from '@application/use-cases/rbac/ListAllPermissionsWithModule';
import { ListPermissionIdsForRole } from '@application/use-cases/rbac/ListPermissionIdsForRole';
import { SetRolePermissions } from '@application/use-cases/rbac/SetRolePermissions';

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

interface TestFixture {
  app: express.Application;
  superAdminUserId: string;
  noPermUserId: string;
  superAdminRoleId: string;
  regularRoleId: string;
  permAId: string;
  permBId: string;
}

async function buildTestApp(): Promise<TestFixture> {
  const roleRepo      = new InMemoryRbacRoleRepository();
  const userRoleRepo  = new InMemoryRbacUserRoleRepository(roleRepo);
  const permRepo      = new InMemoryRbacPermissionRepository();
  const rolePermRepo  = new InMemoryRbacRolePermissionRepository();
  const hasher        = new InMemoryPasswordHasher();
  const userRepo      = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Patch userRepo so requirePermission can resolve roles/permissions from the
  // in-memory pivot repos (same pattern as rbacUser.routes.test.ts)
  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map(id => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      const allPerms = await permRepo.listAll();
      for (const permId of permIds) {
        const p = allPerms.find(ap => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  // Seed roles
  const superAdminRole  = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
  const regularRole     = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });

  // Seed permissions
  const permA = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
  const permB = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });

  // Seed rbac.read + rbac.manage_roles permissions and grant them (for noPermUser test: not granted)
  const rbacReadPerm        = await permRepo.seed({ moduleCode: 'rbac', action: 'read' });
  const rbacManageRolesPerm = await permRepo.seed({ moduleCode: 'rbac', action: 'manage_roles' });

  // Seed users
  const pwHash = await hasher.hash('password123');
  const superAdminUser = await userRepo.create({
    name: 'Super Admin', email: 'super@example.com',
    login: 'superadmin', passwordHash: pwHash, status: 'active',
  });
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const noPermUser = await userRepo.create({
    name: 'No Perm', email: 'noperm@example.com',
    login: 'noperm', passwordHash: pwHash, status: 'active',
  });
  // noPermUser has NO roles → 403 on all protected endpoints

  // Use cases
  const listAllPermissions  = new ListAllPermissionsWithModule(permRepo);
  const listPermIds         = new ListPermissionIdsForRole(roleRepo, rolePermRepo);
  const setRolePerms        = new SetRolePermissions(roleRepo, rolePermRepo, permRepo);

  const requireRbacRead         = requirePermission(userRepo, 'rbac', 'read');
  const requireRbacManageRoles  = requirePermission(userRepo, 'rbac', 'manage_roles');

  // Build express app
  const app = express();
  app.use(express.json());

  // Test auth middleware — inject req.user from x-test-user-id header
  app.use((req: Request, _res: Response, next: NextFunction): void => {
    const testUserId = req.headers['x-test-user-id'] as string | undefined;
    if (testUserId) {
      (req as any).user = { id: testUserId, username: 'test', email: 'test@example.com' };
    }
    next();
  });

  // Permissions catalog router
  app.use(
    '/api/admin/rbac/permissions',
    requireRbacRead,
    createPermissionsRouter(listAllPermissions),
  );

  // Role permissions sub-resource router
  app.use(
    '/api/admin/rbac/roles',
    createRolePermissionsRouter(listPermIds, setRolePerms, requireRbacRead, requireRbacManageRoles),
  );

  app.use(errorHandler);

  return {
    app,
    superAdminUserId: superAdminUser.id,
    noPermUserId: noPermUser.id,
    superAdminRoleId: superAdminRole.id,
    regularRoleId: regularRole.id,
    permAId: permA.id,
    permBId: permB.id,
  };
}

function authed(req: request.Test, userId: string): request.Test {
  return req.set('x-test-user-id', userId);
}

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/rbac/permissions (catalog)
// ---------------------------------------------------------------------------

describe('GET /api/admin/rbac/permissions', () => {
  let fixture: TestFixture;

  beforeAll(async () => {
    fixture = await buildTestApp();
  });

  it('S9: returns 200 with permissions array containing moduleCode + action', async () => {
    const res = await authed(
      request(fixture.app).get('/api/admin/rbac/permissions'),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('permissions');
    expect(Array.isArray(res.body.permissions)).toBe(true);
    expect(res.body.permissions.length).toBeGreaterThan(0);

    const perm = res.body.permissions[0];
    expect(perm).toHaveProperty('id');
    expect(perm).toHaveProperty('moduleCode');
    expect(perm).toHaveProperty('action');
  });

  it('S: unauthenticated → 401', async () => {
    const res = await request(fixture.app).get('/api/admin/rbac/permissions');
    expect(res.status).toBe(401);
  });

  it('S: lacks rbac.read → 403', async () => {
    const res = await authed(
      request(fixture.app).get('/api/admin/rbac/permissions'),
      fixture.noPermUserId,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/admin/rbac/roles/:id/permissions
// ---------------------------------------------------------------------------

describe('GET /api/admin/rbac/roles/:id/permissions', () => {
  let fixture: TestFixture;

  beforeAll(async () => {
    fixture = await buildTestApp();
  });

  it('S1: role with 0 permissions → 200 with empty permissionIds array', async () => {
    const res = await authed(
      request(fixture.app).get(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('permissionIds');
    expect(Array.isArray(res.body.permissionIds)).toBe(true);
  });

  it('S2: unknown role → 404 with code ROLE_NOT_FOUND', async () => {
    const res = await authed(
      request(fixture.app).get('/api/admin/rbac/roles/non-existent-id/permissions'),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROLE_NOT_FOUND');
  });

  it('S: unauthenticated → 401', async () => {
    const res = await request(fixture.app)
      .get(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`);
    expect(res.status).toBe(401);
  });

  it('S: lacks rbac.read → 403', async () => {
    const res = await authed(
      request(fixture.app).get(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`),
      fixture.noPermUserId,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: PUT /api/admin/rbac/roles/:id/permissions
// ---------------------------------------------------------------------------

describe('PUT /api/admin/rbac/roles/:id/permissions', () => {
  let fixture: TestFixture;

  beforeAll(async () => {
    fixture = await buildTestApp();
  });

  it('S3: happy path bulk replace → 200 with updated permissionIds', async () => {
    const res = await authed(
      request(fixture.app)
        .put(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`)
        .send({ permissionIds: [fixture.permAId, fixture.permBId] }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('permissionIds');
    expect(res.body.permissionIds).toContain(fixture.permAId);
    expect(res.body.permissionIds).toContain(fixture.permBId);
  });

  it('S4: super_admin role → 400 with code SUPER_ADMIN_IMMUTABLE', async () => {
    const res = await authed(
      request(fixture.app)
        .put(`/api/admin/rbac/roles/${fixture.superAdminRoleId}/permissions`)
        .send({ permissionIds: [fixture.permAId] }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SUPER_ADMIN_IMMUTABLE');
  });

  it('S5: invalid permissionId → 400 with code INVALID_PERMISSION_IDS', async () => {
    const res = await authed(
      request(fixture.app)
        .put(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`)
        .send({ permissionIds: ['fake-perm-id-abc'] }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PERMISSION_IDS');
  });

  it('S6: empty array → 200 with empty permissionIds', async () => {
    const res = await authed(
      request(fixture.app)
        .put(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`)
        .send({ permissionIds: [] }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.permissionIds).toEqual([]);
  });

  it('S2: unknown role → 404 with code ROLE_NOT_FOUND', async () => {
    const res = await authed(
      request(fixture.app)
        .put('/api/admin/rbac/roles/non-existent-id/permissions')
        .send({ permissionIds: [] }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROLE_NOT_FOUND');
  });

  it('S7: unauthenticated → 401', async () => {
    const res = await request(fixture.app)
      .put(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`)
      .send({ permissionIds: [] });
    expect(res.status).toBe(401);
  });

  it('S8: lacks rbac.manage_roles → 403', async () => {
    const res = await authed(
      request(fixture.app)
        .put(`/api/admin/rbac/roles/${fixture.regularRoleId}/permissions`)
        .send({ permissionIds: [] }),
      fixture.noPermUserId,
    );
    expect(res.status).toBe(403);
  });
});
