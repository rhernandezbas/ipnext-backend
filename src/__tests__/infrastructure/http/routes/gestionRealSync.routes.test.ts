/**
 * gestionRealSync.routes.test.ts — supertest integration for the RBAC-guarded
 * GR client-sync config/status endpoints:
 *   GET /sync/config   (gestionReal:read)
 *   PUT /sync/config   (gestionReal:write)
 *   GET /sync/status   (gestionReal:read)
 *
 * Wiring mirrors rbacRoles.routes.test.ts (in-memory RBAC repos + requirePermission)
 * and gestionRealIngest.routes.test.ts (FakeAuthProvider + in-memory config repo).
 *
 * Auth: the cookie token IS the user id; FakeAuthProvider.getSession echoes it
 * back as req.user.id, so requirePermission resolves perms against the seeded user.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryGestionRealSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryMirrorCountsRepository } from '@infrastructure/adapters/in-memory/InMemoryMirrorCountsRepository';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createGestionRealSyncRouter } from '@infrastructure/http/routes/gestionRealSync.routes';

import { GetSyncConfig } from '@application/use-cases/GetSyncConfig';
import { UpdateSyncConfig } from '@application/use-cases/UpdateSyncConfig';
import { GetGestionRealSyncStatus } from '@application/use-cases/GetGestionRealSyncStatus';
import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';
import { ArmGrContractsBackfill } from '@application/use-cases/ArmGrContractsBackfill';
import { ResyncAllGr } from '@application/use-cases/ResyncAllGr';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// Echo the cookie token back as the user id (token === userId for the test).
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

interface Fixture {
  app: express.Express;
  config: InMemoryGestionRealSyncConfigRepository;
  state: InMemorySyncStateRepository;
  readUserId: string;     // gestionReal:read only
  writeUserId: string;    // gestionReal:read + write
  superAdminUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Resolve roles/permissions through the in-memory pivots (same shim as rbacRoles test).
  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map((id) => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find((ap) => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  // Roles
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
  const readerRole     = await roleRepo.create({ code: 'gr_reader', label: 'GR Reader', isSystem: false });
  const writerRole     = await roleRepo.create({ code: 'gr_writer', label: 'GR Writer', isSystem: false });

  // Permissions: gestionReal:read + gestionReal:write
  const readPerm  = await permRepo.seed({ moduleCode: 'gestionReal', action: 'read' });
  const writePerm = await permRepo.seed({ moduleCode: 'gestionReal', action: 'write' });

  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(writerRole.id, readPerm.id);
  await rolePermRepo.grant(writerRole.id, writePerm.id);

  // Users
  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const superAdminUser = await mkUser('super');
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);
  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const writeUser = await mkUser('writer');
  await userRoleRepo.assign(writeUser.id, writerRole.id);
  const noPermUser = await mkUser('noperm');

  // Use cases + collaborators
  const config = new InMemoryGestionRealSyncConfigRepository();
  const state = new InMemorySyncStateRepository();
  const counts = new InMemoryMirrorCountsRepository();
  const getSyncConfig = new GetSyncConfig(config);
  const updateSyncConfig = new UpdateSyncConfig(config);
  const getSyncStatus = new GetGestionRealSyncStatus(state, counts);
  const reset = new ResetGrClientsCursor(state);
  const arm = new ArmGrContractsBackfill(state);
  const resyncAll = new ResyncAllGr(reset, arm);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/gestion-real/sync',
    createGestionRealSyncRouter(
      new EchoAuthProvider(), undefined, requirePerm, getSyncConfig, updateSyncConfig, getSyncStatus, reset, resyncAll,
    ),
  );
  app.use(errorHandler);

  return {
    app,
    config,
    state,
    readUserId: readUser.id,
    writeUserId: writeUser.id,
    superAdminUserId: superAdminUser.id,
    noPermUserId: noPermUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('gestionRealSync.routes', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await buildApp();
  });

  // ── GET /sync/config ───────────────────────────────────────────────────────

  it('GET /config with gestionReal:read → 200 DTO { intervalMs, estados[] }, no raw entity (REQ-GETCFG-1)', async () => {
    await fx.config.update({ intervalMs: 300000, estados: ['1', '3', '6'] });
    const res = await asUser(request(fx.app).get('/api/gestion-real/sync/config'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ intervalMs: 300000, estados: ['1', '3', '6'] });
    expect(res.body).not.toHaveProperty('id');
    expect(res.body).not.toHaveProperty('updatedAt');
  });

  it('GET /config without permission → 403 PERMISSION_DENIED { module, action:read } (REQ-RBAC-1)', async () => {
    const res = await asUser(request(fx.app).get('/api/gestion-real/sync/config'), fx.noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(res.body.module).toBe('gestionReal');
    expect(res.body.action).toBe('read');
  });

  it('GET /config as super_admin (no explicit perm) → 200 (short-circuit)', async () => {
    const res = await asUser(request(fx.app).get('/api/gestion-real/sync/config'), fx.superAdminUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('intervalMs');
  });

  // ── GET /sync/status ───────────────────────────────────────────────────────

  it('GET /status with gestionReal:read → 200 status view', async () => {
    const res = await asUser(request(fx.app).get('/api/gestion-real/sync/status'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hasRun');
    expect(res.body).toHaveProperty('clientCount');
  });

  it('GET /status without permission → 403', async () => {
    const res = await asUser(request(fx.app).get('/api/gestion-real/sync/status'), fx.noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  // ── PUT /sync/config ───────────────────────────────────────────────────────

  it('PUT /config with gestionReal:write + { intervalMs } → 200 updated DTO (REQ-PUTCFG-1)', async () => {
    const res = await asUser(
      request(fx.app).put('/api/gestion-real/sync/config').send({ intervalMs: 300000 }),
      fx.writeUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.intervalMs).toBe(300000);
    expect(res.body.estados).toEqual(['1', '2', '3', '4', '6']);
  });

  it('PUT /config with only gestionReal:read → 403 { action:write }, config unchanged (REQ-RBAC-2)', async () => {
    const res = await asUser(
      request(fx.app).put('/api/gestion-real/sync/config').send({ intervalMs: 999999 }),
      fx.readUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(res.body.action).toBe('write');
    const after = await fx.config.get();
    expect(after.intervalMs).toBe(180000);
  });

  it('PUT /config intervalMs:"soon" → 400 VALIDATION_ERROR (REQ-PUTCFG-2)', async () => {
    const res = await asUser(
      request(fx.app).put('/api/gestion-real/sync/config').send({ intervalMs: 'soon' }),
      fx.writeUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /config estados:["9"] → 400 VALIDATION_ERROR (REQ-PUTCFG-2)', async () => {
    const res = await asUser(
      request(fx.app).put('/api/gestion-real/sync/config').send({ estados: ['9'] }),
      fx.writeUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /config intervalMs:0 → 400 VALIDATION_ERROR (REQ-PUTCFG-2)', async () => {
    const res = await asUser(
      request(fx.app).put('/api/gestion-real/sync/config').send({ intervalMs: 0 }),
      fx.writeUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // ── POST /sync/resync-all ────────────────────────────────────────────────────

  async function seedClientsCursor(): Promise<void> {
    await fx.state.save({
      entity: 'gr-clients', cursor: '25-05-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 100,
    });
  }

  it('POST /resync-all with gestionReal:write → 200, resets clients + arms backfill (REQ-RESYNCALL-1)', async () => {
    await seedClientsCursor();
    const res = await asUser(request(fx.app).post('/api/gestion-real/sync/resync-all'), fx.writeUserId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('clients');
    expect(res.body).toHaveProperty('contractsBackfill');
    expect(res.body).toHaveProperty('message');
    expect(res.body.clients).toEqual({ entity: 'gr-clients', cursor: null });
    expect(res.body.contractsBackfill).toEqual({ armed: true, offset: 0 });
    expect((await fx.state.get('gr-clients'))?.cursor).toBeNull();
    expect((await fx.state.get('gr-contracts-backfill'))?.cursor).toBe('0');
  });

  it('POST /resync-all with only gestionReal:read → 403; watermarks unchanged (REQ-RESYNCALL-RBAC-1)', async () => {
    await seedClientsCursor();
    const res = await asUser(request(fx.app).post('/api/gestion-real/sync/resync-all'), fx.readUserId);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED', module: 'gestionReal', action: 'write' });
    expect((await fx.state.get('gr-clients'))?.cursor).toBe('25-05-2026');
    expect(await fx.state.get('gr-contracts-backfill')).toBeNull();
  });

  it('POST /resync-all with no gestionReal permission → 403 (REQ-RESYNCALL-RBAC-1)', async () => {
    const res = await asUser(request(fx.app).post('/api/gestion-real/sync/resync-all'), fx.noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('POST /resync-all as super_admin → 200 (short-circuit) (REQ-RESYNCALL-RBAC-1)', async () => {
    await seedClientsCursor();
    const res = await asUser(request(fx.app).post('/api/gestion-real/sync/resync-all'), fx.superAdminUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contractsBackfill');
  });

  it('POST /resync-all with no auth cookie → 401; watermarks unchanged (REQ-RESYNCALL-AUTH-1)', async () => {
    await seedClientsCursor();
    const res = await request(fx.app).post('/api/gestion-real/sync/resync-all');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect((await fx.state.get('gr-clients'))?.cursor).toBe('25-05-2026');
    expect(await fx.state.get('gr-contracts-backfill')).toBeNull();
  });

  // ── POST /sync/reset (kept — clients only) ───────────────────────────────────

  it('POST /reset with gestionReal:write → 200, clears only the client cursor (REQ-RESET-1)', async () => {
    await seedClientsCursor();
    // Pre-armed backfill must remain UNTOUCHED by reset.
    await fx.state.save({
      entity: 'gr-contracts-backfill', cursor: '3', lastRunAt: new Date(), lastResult: 'batch ok @3', itemsSynced: 3,
    });

    const res = await asUser(request(fx.app).post('/api/gestion-real/sync/reset'), fx.writeUserId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entity: 'gr-clients', cursor: null });
    expect(res.body).toHaveProperty('message');
    expect((await fx.state.get('gr-clients'))?.cursor).toBeNull();
    // Reset does NOT arm/touch the contract backfill.
    expect((await fx.state.get('gr-contracts-backfill'))?.cursor).toBe('3');
  });

  it('POST /reset with only gestionReal:read → 403 { action:write }, cursor unchanged (REQ-RESET-1)', async () => {
    await seedClientsCursor();
    const res = await asUser(request(fx.app).post('/api/gestion-real/sync/reset'), fx.readUserId);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED', action: 'write' });
    expect((await fx.state.get('gr-clients'))?.cursor).toBe('25-05-2026');
  });
});
