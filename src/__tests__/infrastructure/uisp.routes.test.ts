/**
 * UISP routes integration tests — SCEN-API-01..06, SCEN-API-03, SCEN-SYNC-05..06.
 * Uses supertest + in-memory repos. No DB, no live UISP calls.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createUispRouter } from '../../infrastructure/http/routes/uisp.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { requirePermission } from '../../infrastructure/http/middleware/requirePermission';
import { ListUispSites } from '../../application/use-cases/ListUispSites';
import { GetUispSiteDetail } from '../../application/use-cases/GetUispSiteDetail';
import { GetUispSyncStatus } from '../../application/use-cases/GetUispSyncStatus';
import { TriggerUispSync } from '../../application/use-cases/TriggerUispSync';
import { InMemoryUispSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import type { UispSite, UispDevice } from '../../domain/entities/uisp';
import type { AuthProvider } from '../../domain/ports/AuthProvider';
import type { User } from '../../domain/entities/auth';
import type { RbacPermission } from '../../domain/entities/rbac';
import type { UispSyncScheduler, TriggerResult } from '../../infrastructure/scheduling/UispSyncScheduler';

// EchoAuthProvider: cookie token = userId
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

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: `internal-${uispId}`,
    uispId,
    name: `Site ${uispId}`,
    status: 'unknown',
    parentUispId: null,
    latitude: -34.89844,
    longitude: -60.01962,
    deviceCount: 5,
    outageCount: 1,
    contact: 'Pablo Sarto',
    address: null,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDevice(uispId: string, uispSiteId: string): UispDevice {
  return {
    id: `dev-${uispId}`,
    uispId,
    uispSiteId,
    name: `Device ${uispId}`,
    model: 'LBE-5AC-Gen2',
    modelName: 'LiteBeam 5AC',
    type: 'airMax',
    role: 'station',
    mac: null,
    ip: '100.64.1.1',
    firmware: null,
    status: 'active',
    signal: -70,
    uptime: BigInt(12345),
    lastSeenAt: now,
    missingSince: null,
    apUispDeviceId: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function buildFixture(schedulerResult: TriggerResult = { queued: true }) {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Wire resolution methods (same pattern as featureFlags.routes.rbac.test.ts)
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

  // Roles + users
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
  const readerRole     = await roleRepo.create({ code: 'noc', label: 'NOC', isSystem: true });
  const plainRole      = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });

  // Permissions
  const uispReadPerm   = await permRepo.seed({ moduleCode: 'uisp', action: 'read' });
  const uispManagePerm = await permRepo.seed({ moduleCode: 'uisp', action: 'manage' });

  await rolePermRepo.grant(readerRole.id, uispReadPerm.id);
  await rolePermRepo.grant(readerRole.id, uispManagePerm.id);

  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@test.com`, login, passwordHash: 'hash', status: 'active' });

  const superAdminUser = await mkUser('superadmin');
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const readerUser = await mkUser('noc');
  await userRoleRepo.assign(readerUser.id, readerRole.id);

  const noPermUser = await mkUser('tecnico');
  await userRoleRepo.assign(noPermUser.id, plainRole.id);

  // Repos
  const siteRepo   = new InMemoryUispSiteRepository();
  const deviceRepo = new InMemoryUispDeviceRepository();
  const syncState  = new InMemorySyncStateRepository();
  const flags      = new InMemoryFeatureFlagRepository();

  // Seed data
  siteRepo.seed(makeSite('site-1'));
  siteRepo.seed(makeSite('site-2'));
  deviceRepo.seed(makeDevice('dev-1', 'site-1'));
  deviceRepo.seed(makeDevice('dev-2', 'site-1'));

  // Scheduler stub
  const scheduler = { triggerNow: async () => schedulerResult } as unknown as UispSyncScheduler;

  // Use cases
  const listSites     = new ListUispSites(siteRepo);
  const getSiteDetail = new GetUispSiteDetail(siteRepo, deviceRepo);
  const getSyncStatus = new GetUispSyncStatus(syncState, flags, true);
  const triggerSync   = new TriggerUispSync(scheduler);

  // Middleware
  const authProvider = new EchoAuthProvider();
  const requireRead   = requirePermission(userRepo, 'uisp', 'read');
  const requireManage = requirePermission(userRepo, 'uisp', 'manage');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Auth middleware: decode token from cookie, set req.user
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const token = req.cookies?.auth_token as string | undefined;
    if (token) {
      void authProvider.getSession(token).then(user => {
        (req as any).user = user;
        next();
      });
    } else {
      next();
    }
  });

  app.use('/api/uisp', createUispRouter(listSites, getSiteDetail, getSyncStatus, triggerSync, requireRead, requireManage));
  app.use(errorHandler);

  return { app, superAdminUser, readerUser, noPermUser };
}

function withToken(req: request.Test, userId: string) {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('UISP routes', () => {
  // SCEN-API-03: 403 without uisp:read
  it('SCEN-API-03: GET /sites without uisp:read → 403', async () => {
    const { app, noPermUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sites'), noPermUser.id);
    expect(res.status).toBe(403);
  });

  it('GET /sites without auth → 401', async () => {
    const { app } = await buildFixture();
    const res = await request(app).get('/api/uisp/sites');
    expect(res.status).toBe(401);
  });

  // SCEN-API-01: 200 with sites list
  it('SCEN-API-01: GET /sites → 200 with sites array', async () => {
    const { app, readerUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sites'), readerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.sites).toHaveLength(2);
    expect(res.body.sites[0].uispId).toBeDefined();
    expect(res.body.sites[0].name).toBeDefined();
  });

  // SCEN-API-02: status "unknown" served as-is
  it('SCEN-API-02: GET /sites returns status "unknown" as-is', async () => {
    const { app, readerUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sites'), readerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.sites[0].status).toBe('unknown');
  });

  // SCEN-API-04: GET /sites/:uispId → site detail + devices
  it('SCEN-API-04: GET /sites/:uispId → 200 with site detail and devices', async () => {
    const { app, readerUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sites/site-1'), readerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.site.uispId).toBe('site-1');
    expect(res.body.devices).toHaveLength(2);
  });

  it('GET /sites/:uispId returns uptime as string in device DTO', async () => {
    const { app, readerUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sites/site-1'), readerUser.id);
    expect(res.status).toBe(200);
    expect(typeof res.body.devices[0].uptime).toBe('string');
    expect(res.body.devices[0].uptime).toBe('12345');
  });

  // SCEN-API-05: 404 for unknown uispId
  it('SCEN-API-05: GET /sites/unknown → 404', async () => {
    const { app, readerUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sites/nonexistent'), readerUser.id);
    expect(res.status).toBe(404);
  });

  // SCEN-API-06: GET /sync/status → configured/enabled
  it('SCEN-API-06: GET /sync/status → 200 with configured and enabled', async () => {
    const { app, readerUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sync/status'), readerUser.id);
    expect(res.status).toBe(200);
    expect('configured' in res.body).toBe(true);
    expect('enabled' in res.body).toBe(true);
    expect('lastRunAt' in res.body).toBe(true);
  });

  // SCEN-SYNC-05: POST /sync → 202 queued
  it('SCEN-SYNC-05: POST /sync → 202 { queued: true }', async () => {
    const { app, readerUser } = await buildFixture({ queued: true });
    const res = await withToken(request(app).post('/api/uisp/sync'), readerUser.id);
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
  });

  // SCEN-SYNC-06: POST /sync when already running → 409
  it('SCEN-SYNC-06: POST /sync when already running → 409 with reason', async () => {
    const { app, readerUser } = await buildFixture({ queued: false, reason: 'already-running' });
    const res = await withToken(request(app).post('/api/uisp/sync'), readerUser.id);
    expect(res.status).toBe(409);
    expect(res.body.queued).toBe(false);
    expect(res.body.reason).toBe('already-running');
  });

  // POST /sync without uisp:manage → 403
  it('POST /sync without uisp:manage → 403', async () => {
    const { app, noPermUser } = await buildFixture();
    const res = await withToken(request(app).post('/api/uisp/sync'), noPermUser.id);
    expect(res.status).toBe(403);
  });

  // super_admin short-circuit
  it('super_admin bypasses requirePerm on GET /sites', async () => {
    const { app, superAdminUser } = await buildFixture();
    const res = await withToken(request(app).get('/api/uisp/sites'), superAdminUser.id);
    expect(res.status).toBe(200);
  });
});
