/**
 * requirePermission middleware — supertest integration tests.
 *
 * Builds a throwaway Express app per scenario. Uses SeedableRbacUserRepo
 * (extends InMemoryRbacUserRepository) to inject roles/permissions per user
 * without touching Prisma or global state.
 *
 * Scenarios:
 *  1. Granted — user with matching (module, action) permission → 200
 *  2. Denied  — user lacks permission → 403 PERMISSION_DENIED
 *  3. super_admin short-circuit — no permission rows → still 200
 *  4. Unauthenticated — no req.user → 401 NO_USER_CONTEXT
 *  5. Unknown module — middleware called with unknown module code → 403 PERMISSION_DENIED
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryRbacUserRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { requirePermission } from '../../../infrastructure/http/middleware/requirePermission';
import type { RbacRole, RbacPermission, RbacModuleCode, PermissionAction } from '../../../domain/entities/rbac';

// ---------------------------------------------------------------------------
// SeedableRbacUserRepo — test-only subclass that overrides listRolesForUser
// and listPermissionsForUser to return pre-seeded data.
// ---------------------------------------------------------------------------

class SeedableRbacUserRepo extends InMemoryRbacUserRepository {
  private readonly userRoles = new Map<string, RbacRole[]>();
  private readonly userPermissions = new Map<string, RbacPermission[]>();

  seedRoles(userId: string, roles: RbacRole[]): void {
    this.userRoles.set(userId, roles);
  }

  seedPermissions(userId: string, permissions: RbacPermission[]): void {
    this.userPermissions.set(userId, permissions);
  }

  override async listRolesForUser(userId: string): Promise<RbacRole[]> {
    return this.userRoles.get(userId) ?? [];
  }

  override async listPermissionsForUser(userId: string): Promise<RbacPermission[]> {
    return this.userPermissions.get(userId) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Helper: builds a minimal Express app with one protected route.
// The `injectUser` flag controls whether a stub `req.user` is set before
// the middleware runs.
// ---------------------------------------------------------------------------

function buildApp(
  userRepo: SeedableRbacUserRepo,
  module: string,
  action: PermissionAction,
  injectUser?: { id: string },
) {
  const app = express();
  app.use(express.json());

  // Stub auth: sets req.user when injectUser is provided
  if (injectUser) {
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      (_req as any).user = injectUser;
      next();
    });
  }

  // The route is protected by requirePermission
  app.get(
    '/test',
    requirePermission(userRepo, module as RbacModuleCode, action),
    (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    },
  );

  return app;
}

// ---------------------------------------------------------------------------
// Scenario 1: Granted — user with matching (network, read) permission → 200
// ---------------------------------------------------------------------------

describe('requirePermission middleware', () => {
  it('1. GRANTED — user with matching permission receives 200', async () => {
    const userRepo = new SeedableRbacUserRepo();
    const user = await userRepo.create({
      name: 'NOC User',
      email: 'noc@test.com',
      login: 'noc1',
      passwordHash: 'x',
    });

    userRepo.seedRoles(user.id, [
      { id: 'role-noc', code: 'noc', label: 'NOC', isSystem: true },
    ]);
    userRepo.seedPermissions(user.id, [
      { id: 'perm-1', moduleCode: 'network', action: 'read' },
    ]);

    const app = buildApp(userRepo, 'network', 'read', { id: user.id });
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Denied — user lacks permission → 403 PERMISSION_DENIED
  // -------------------------------------------------------------------------

  it('2. DENIED — user without matching permission receives 403', async () => {
    const userRepo = new SeedableRbacUserRepo();
    const user = await userRepo.create({
      name: 'Ventas User',
      email: 'ventas@test.com',
      login: 'ventas1',
      passwordHash: 'x',
    });

    userRepo.seedRoles(user.id, [
      { id: 'role-ventas', code: 'ventas', label: 'Ventas', isSystem: true },
    ]);
    // No billing:write permission
    userRepo.seedPermissions(user.id, [
      { id: 'perm-2', moduleCode: 'clients', action: 'read' },
    ]);

    const app = buildApp(userRepo, 'billing', 'write', { id: user.id });
    const res = await request(app).get('/test');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.module).toBe('billing');
    expect(res.body.action).toBe('write');
  });

  // -------------------------------------------------------------------------
  // Scenario 3: super_admin short-circuit — no permission rows, still 200
  // -------------------------------------------------------------------------

  it('3. SUPER_ADMIN — bypasses permission check even with zero permission rows', async () => {
    const userRepo = new SeedableRbacUserRepo();
    const user = await userRepo.create({
      name: 'Super Admin',
      email: 'sa@test.com',
      login: 'superadmin1',
      passwordHash: 'x',
    });

    userRepo.seedRoles(user.id, [
      { id: 'role-sa', code: 'super_admin', label: 'Super Admin', isSystem: true },
    ]);
    // Intentionally NO permissions seeded — proves short-circuit doesn't query them
    userRepo.seedPermissions(user.id, []);

    const app = buildApp(userRepo, 'settings', 'delete', { id: user.id });
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Unauthenticated — no req.user → 401 NO_USER_CONTEXT
  // -------------------------------------------------------------------------

  it('4. UNAUTHENTICATED — no req.user returns 401 NO_USER_CONTEXT', async () => {
    const userRepo = new SeedableRbacUserRepo();
    // No injectUser — req.user will be undefined
    const app = buildApp(userRepo, 'clients', 'read', undefined);
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_USER_CONTEXT');
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Unknown module — fail-closed → 403 PERMISSION_DENIED (not 500)
  // -------------------------------------------------------------------------

  it('5. UNKNOWN MODULE — fail-closed with 403 PERMISSION_DENIED', async () => {
    const userRepo = new SeedableRbacUserRepo();
    const user = await userRepo.create({
      name: 'Some User',
      email: 'user@test.com',
      login: 'user1',
      passwordHash: 'x',
    });

    userRepo.seedRoles(user.id, [
      { id: 'role-admin', code: 'administrador', label: 'Admin', isSystem: true },
    ]);
    userRepo.seedPermissions(user.id, [
      { id: 'perm-3', moduleCode: 'clients', action: 'read' },
    ]);

    // 'nope' is not a valid RbacModuleCode — cast to test unknown input
    const app = buildApp(userRepo, 'nope', 'read', { id: user.id });
    const res = await request(app).get('/test');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});
