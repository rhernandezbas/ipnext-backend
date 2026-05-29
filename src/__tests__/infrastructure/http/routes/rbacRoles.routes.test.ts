/**
 * rbacRoles.routes.test.ts — supertest integration tests for
 * POST   /api/admin/rbac/roles        (create)
 * DELETE /api/admin/rbac/roles/:id   (delete)
 *
 * SDD #3 Phase 4b — role catalog mutation routes.
 *
 * Setup:
 *   - Minimal Express app with InMemory repos.
 *   - superAdminUser → super_admin role → short-circuits all requirePerm checks.
 *   - noPermUser     → no roles → 403 PERMISSION_DENIED.
 *   - Auth bypassed by injecting req.user via x-test-user-id header.
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

import { CreateRbacRole } from '@application/use-cases/rbac/CreateRbacRole';
import { DeleteRbacRole } from '@application/use-cases/rbac/DeleteRbacRole';

import { toRbacRoleDto } from '@application/dto/rbacUser.dto';

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

interface TestFixture {
  app: express.Application;
  superAdminUserId: string;
  noPermUserId: string;
  systemRoleId: string;
  customRoleId: string;
}

async function buildTestApp(): Promise<TestFixture> {
  const roleRepo      = new InMemoryRbacRoleRepository();
  const userRoleRepo  = new InMemoryRbacUserRoleRepository();
  const permRepo      = new InMemoryRbacPermissionRepository();
  const rolePermRepo  = new InMemoryRbacRolePermissionRepository();
  const hasher        = new InMemoryPasswordHasher();
  const userRepo      = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Patch userRepo so requirePermission resolves from in-memory pivot repos
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
  const systemRole      = await roleRepo.create({ code: 'noc', label: 'NOC', isSystem: true });
  const customRole      = await roleRepo.create({ code: 'existing_custom', label: 'Existing Custom', isSystem: false });

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

  // Use cases
  const createRoleUC = new CreateRbacRole(roleRepo);
  const deleteRoleUC = new DeleteRbacRole(roleRepo);

  const requireRbacRead        = requirePermission(userRepo, 'rbac', 'read');
  const requireRbacManageRoles = requirePermission(userRepo, 'rbac', 'manage_roles');

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

  // GET / — list roles (rbac.read)
  app.get('/api/admin/rbac/roles', requireRbacRead, async (_req, res, next) => {
    try {
      const roles = await roleRepo.listAll();
      res.json({ roles: roles.map(toRbacRoleDto) });
    } catch (err) { next(err); }
  });

  // POST / — create role (rbac.manage_roles)
  app.post('/api/admin/rbac/roles', requireRbacManageRoles, async (req, res, next) => {
    try {
      const role = await createRoleUC.execute(req.body);
      res.status(201).json(toRbacRoleDto(role));
    } catch (err) { next(err); }
  });

  // DELETE /:id — delete role (rbac.manage_roles)
  app.delete('/api/admin/rbac/roles/:id', requireRbacManageRoles, async (req, res, next) => {
    try {
      await deleteRoleUC.execute(req.params.id);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.use(errorHandler);

  return {
    app,
    superAdminUserId: superAdminUser.id,
    noPermUserId: noPermUser.id,
    systemRoleId: systemRole.id,
    customRoleId: customRole.id,
  };
}

function authed(req: request.Test, userId: string): request.Test {
  return req.set('x-test-user-id', userId);
}

// ---------------------------------------------------------------------------
// Tests: POST /api/admin/rbac/roles
// ---------------------------------------------------------------------------

describe('POST /api/admin/rbac/roles', () => {
  let fixture: TestFixture;

  beforeAll(async () => {
    fixture = await buildTestApp();
  });

  it('returns 201 with the new role on valid input', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'new_role', label: 'New Role', description: 'Test role' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.code).toBe('new_role');
    expect(res.body.label).toBe('New Role');
    expect(res.body.isSystem).toBe(false);
  });

  it('returns 201 without description (optional field)', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'another_role', label: 'Another Role' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(201);
    expect(res.body.code).toBe('another_role');
  });

  it('returns 400 VALIDATION_ERROR on uppercase code', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'BadCode', label: 'Bad Code' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR on code starting with number', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: '1bad', label: 'Bad Code' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR on code with hyphens', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'bad-code', label: 'Bad Code' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR on single-character code', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'a', label: 'Short Code' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR on label too short', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'valid_code', label: 'A' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 ROLE_CODE_TAKEN on duplicate code', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'existing_custom', label: 'Duplicate' }),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_CODE_TAKEN');
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(fixture.app)
      .post('/api/admin/rbac/roles')
      .send({ code: 'unauth_role', label: 'Unauth Role' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks rbac.manage_roles', async () => {
    const res = await authed(
      request(fixture.app)
        .post('/api/admin/rbac/roles')
        .send({ code: 'noperm_role', label: 'No Perm Role' }),
      fixture.noPermUserId,
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/admin/rbac/roles/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/admin/rbac/roles/:id', () => {
  let fixture: TestFixture;

  beforeAll(async () => {
    fixture = await buildTestApp();
  });

  it('returns 204 when deleting an existing custom role', async () => {
    const res = await authed(
      request(fixture.app).delete(`/api/admin/rbac/roles/${fixture.customRoleId}`),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(204);
  });

  it('returns 404 ROLE_NOT_FOUND for unknown id', async () => {
    const res = await authed(
      request(fixture.app).delete('/api/admin/rbac/roles/non-existent-role-id'),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROLE_NOT_FOUND');
  });

  it('returns 403 ROLE_IS_SYSTEM when trying to delete a system role', async () => {
    const res = await authed(
      request(fixture.app).delete(`/api/admin/rbac/roles/${fixture.systemRoleId}`),
      fixture.superAdminUserId,
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ROLE_IS_SYSTEM');
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(fixture.app)
      .delete(`/api/admin/rbac/roles/${fixture.customRoleId}`);

    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks rbac.manage_roles', async () => {
    const res = await authed(
      request(fixture.app).delete(`/api/admin/rbac/roles/${fixture.systemRoleId}`),
      fixture.noPermUserId,
    );

    expect(res.status).toBe(403);
  });
});
