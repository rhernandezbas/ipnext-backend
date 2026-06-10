/**
 * featureFlags.routes.rbac.test.ts
 *
 * Guards the PATCH /api/admin/feature-flags/:key permission requirement:
 *   - PATCH without auth → 401
 *   - PATCH with plain auth but no admin.flags → 403 PERMISSION_DENIED
 *   - PATCH as super_admin → 200 (short-circuit via * sentinel)
 *   - PATCH with explicit admin.flags grant → 200
 *   - GET / with plain auth (no admin.flags) → 200 (auth-only)
 *   - GET /:key with plain auth (no admin.flags) → 200 (auth-only)
 *   - GET / without auth → 401
 *
 * Uses EchoAuthProvider (cookie token = userId) + InMemory RBAC repos.
 * Pattern mirrors iclassResend.routes.test.ts RBAC scenarios (monkey-patch
 * listRolesForUser / listPermissionsForUser on InMemoryRbacUserRepository).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';

import { requirePermission } from '../../infrastructure/http/middleware/requirePermission';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { createFeatureFlagsRouter } from '../../infrastructure/http/routes/featureFlags.routes';

import { ListFeatureFlags } from '../../application/use-cases/ListFeatureFlags';
import { GetFeatureFlag } from '../../application/use-cases/GetFeatureFlag';
import { SetFeatureFlag } from '../../application/use-cases/SetFeatureFlag';

import type { AuthProvider } from '../../domain/ports/AuthProvider';
import type { User } from '../../domain/entities/auth';
import type { RbacPermission } from '../../domain/entities/rbac';

// ─── EchoAuthProvider: cookie token IS the userId ──────────────────────────

class EchoAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'x', username: 't', email: 't@t.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { id: token, username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

// ─── RBAC fixture builder ──────────────────────────────────────────────────

async function buildFixture() {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Wire listRolesForUser + listPermissionsForUser via in-memory pivots
  // (mirrors iclassResend.routes.test.ts pattern — InMemoryRbacUserRepository
  // stubs return [] by default; we need real resolution through the pivot repos).
  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map(id => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find(ap => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  // Roles
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
  const regularRole    = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });
  const flagsRole      = await roleRepo.create({ code: 'flag_manager', label: 'Flag Manager', isSystem: false });

  // Permission: admin.flags
  const adminFlagsPerm = await permRepo.seed({ moduleCode: 'admin', action: 'flags' });

  // Grant admin.flags to flagsRole only
  await rolePermRepo.grant(flagsRole.id, adminFlagsPerm.id);

  // Users
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@test.com`, login, passwordHash: 'irrelevant', status: 'active' });

  const superAdminUser = await mkUser('superadmin');
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const plainUser = await mkUser('tecnico');
  await userRoleRepo.assign(plainUser.id, regularRole.id);

  const flagsUser = await mkUser('flagmgr');
  await userRoleRepo.assign(flagsUser.id, flagsRole.id);

  // Feature flag repo
  const flagRepo = new InMemoryFeatureFlagRepository();
  flagRepo.seed('iclass-integration', false);

  // Build app
  const authProvider = new EchoAuthProvider();
  const requireFlags = requirePermission(userRepo, 'admin', 'flags');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use(
    '/api/admin/feature-flags',
    createFeatureFlagsRouter(
      authProvider,
      new ListFeatureFlags(flagRepo),
      new GetFeatureFlag(flagRepo),
      new SetFeatureFlag(flagRepo),
      requireFlags,
    ),
  );
  app.use(errorHandler);

  return { app, superAdminUser, plainUser, flagsUser };
}

function withToken(req: request.Test, userId: string) {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Feature Flags RBAC — PATCH guard', () => {
  it('PATCH without auth → 401', async () => {
    const { app } = await buildFixture();
    const res = await request(app)
      .patch('/api/admin/feature-flags/iclass-integration')
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('PATCH with plain auth but no admin.flags → 403 PERMISSION_DENIED', async () => {
    const { app, plainUser } = await buildFixture();
    const res = await withToken(
      request(app).patch('/api/admin/feature-flags/iclass-integration').send({ enabled: true }),
      plainUser.id,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(res.body.module).toBe('admin');
    expect(res.body.action).toBe('flags');
  });

  it('PATCH as super_admin → 200 (short-circuit via * sentinel)', async () => {
    const { app, superAdminUser } = await buildFixture();
    const res = await withToken(
      request(app).patch('/api/admin/feature-flags/iclass-integration').send({ enabled: true }),
      superAdminUser.id,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'iclass-integration', enabled: true });
  });

  it('PATCH with explicit admin.flags grant → 200', async () => {
    const { app, flagsUser } = await buildFixture();
    const res = await withToken(
      request(app).patch('/api/admin/feature-flags/iclass-integration').send({ enabled: true }),
      flagsUser.id,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'iclass-integration', enabled: true });
  });
});

describe('Feature Flags RBAC — GET routes remain auth-only', () => {
  it('GET / with plain auth (no admin.flags) → 200', async () => {
    const { app, plainUser } = await buildFixture();
    const res = await withToken(
      request(app).get('/api/admin/feature-flags'),
      plainUser.id,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /:key with plain auth (no admin.flags) → 200', async () => {
    const { app, plainUser } = await buildFixture();
    const res = await withToken(
      request(app).get('/api/admin/feature-flags/iclass-integration'),
      plainUser.id,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'iclass-integration', enabled: false });
  });

  it('GET / without auth → 401', async () => {
    const { app } = await buildFixture();
    const res = await request(app).get('/api/admin/feature-flags');
    expect(res.status).toBe(401);
  });
});
