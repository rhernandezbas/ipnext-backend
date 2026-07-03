/**
 * nas.routes.test.ts — supertest para las rutas NAS + su guard de seguridad.
 *
 * Las rutas NAS estaban montadas en /api SIN auth ni permiso (agujero; fix `network-routes-guard`).
 * Cubre:
 *   - GET /nas-servers (con auth) → 200 con los 3 NAS seed; PUT /radius-config (con manage) actualiza
 *   - 401 sin auth (todas)
 *   - GET /nas-servers con auth pero SIN network.manage → 200 (reads auth-only; el dropdown de
 *     routers del InternetPanel lo consumen usuarios pppoe.manage que no tienen network.read)
 *   - POST/PUT/DELETE /nas-servers + PUT /radius-config sin network.manage → 403
 *   - ...con network.manage → OK (incluye el FLIP del cutover: type → radius_orchestrator)
 *
 * Patrón espejo de pppoe.routes.test.ts (EchoAuthProvider + cookie token = userId + RBAC in-memory).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import type { IpPool } from '@domain/entities/network';

import { createNasRouter } from '@infrastructure/http/routes/nas.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { ListNasServers } from '@application/use-cases/ListNasServers';
import { GetNasServer } from '@application/use-cases/GetNasServer';
import { CreateNasServer } from '@application/use-cases/CreateNasServer';
import { UpdateNasServer } from '@application/use-cases/UpdateNasServer';
import { DeleteNasServer } from '@application/use-cases/DeleteNasServer';
import { GetRadiusConfig } from '@application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '@application/use-cases/UpdateRadiusConfig';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { NAS_SECRET_MASK } from '@domain/entities/nas';

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
  nasRepo: InMemoryNasRepository;
  manageUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

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

  const managerRole = await roleRepo.create({ code: 'network_manager', label: 'Network Manager', isSystem: false });
  const managePerm  = await permRepo.seed({ moduleCode: 'network', action: 'manage' });
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  // noPermUser: sin roles → autenticado pero SIN network.manage

  const nasRepo = new InMemoryNasRepository();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createNasRouter(
    new EchoAuthProvider(),
    undefined, // sessionRepo: stateless en tests
    requirePerm,
    new ListNasServers(nasRepo),
    new GetNasServer(nasRepo),
    new CreateNasServer(nasRepo),
    new UpdateNasServer(nasRepo),
    new DeleteNasServer(nasRepo),
    new GetRadiusConfig(nasRepo),
    new UpdateRadiusConfig(nasRepo),
  ));
  app.use(errorHandler);

  return { app, nasRepo, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('nas.routes — funcionalidad + security guard (auth + network.manage)', () => {
  // ── 401 sin auth ──────────────────────────────────────────────────────────
  it('GET /api/nas-servers sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/nas-servers')).status).toBe(401);
  });
  it('PUT /api/nas-servers/:id sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).put('/api/nas-servers/1').send({ type: 'radius_orchestrator' })).status).toBe(401);
  });
  it('POST /api/nas-servers sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).post('/api/nas-servers').send({})).status).toBe(401);
  });
  it('DELETE /api/nas-servers/:id sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).delete('/api/nas-servers/1')).status).toBe(401);
  });
  it('PUT /api/radius-config sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).put('/api/radius-config').send({})).status).toBe(401);
  });

  // ── GET = auth-only (reads NO requieren network.manage) ─────────────────────
  it('GET /api/nas-servers con auth pero sin network.manage → 200 con los 3 NAS seed', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/nas-servers'), noPermUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });

  // ── writes requieren network.manage → 403 sin permiso ───────────────────────
  it('PUT /api/nas-servers/:id sin network.manage → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).put('/api/nas-servers/1'), noPermUserId).send({ type: 'radius_orchestrator' });
    expect(res.status).toBe(403);
  });
  it('POST /api/nas-servers sin network.manage → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/nas-servers'), noPermUserId).send({ name: 'x' });
    expect(res.status).toBe(403);
  });
  it('DELETE /api/nas-servers/:id sin network.manage → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).delete('/api/nas-servers/1'), noPermUserId);
    expect(res.status).toBe(403);
  });
  it('PUT /api/radius-config sin network.manage → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).put('/api/radius-config'), noPermUserId).send({ authPort: 1812 });
    expect(res.status).toBe(403);
  });

  // ── writes con network.manage → OK (incluye el FLIP del cutover) ────────────
  it('PUT /api/nas-servers/:id con network.manage flipea el type (cutover) → 200', async () => {
    const { app, manageUserId, nasRepo } = await buildApp();
    const res = await asUser(request(app).put('/api/nas-servers/1'), manageUserId).send({ type: 'radius_orchestrator' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('radius_orchestrator');
    const updated = await nasRepo.findNasServerById('1');
    expect(updated?.type).toBe('radius_orchestrator');
  });
  it('DELETE /api/nas-servers/:id con network.manage → 204', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).delete('/api/nas-servers/2'), manageUserId);
    expect(res.status).toBe(204);
  });
  it('PUT /api/radius-config con network.manage → 200 con la config actualizada', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).put('/api/radius-config'), manageUserId).send({ sessionTimeout: 7200 });
    expect(res.status).toBe(200);
    expect(res.body.sessionTimeout).toBe(7200);
    expect(res.body.authPort).toBe(1812);
  });
});

// --- HTTP SEAM: NAS live counters via GET /api/nas-servers + GET /api/nas-servers/:id ---

interface LiveFixture { app: express.Express; manageUserId: string; noPermUserId: string; }

async function buildAppWithLive(): Promise<LiveFixture> {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

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
        const px = allPerms.find((ap) => ap.id === permId);
        if (px) perms.push(px);
      }
    }
    return perms;
  };

  const managerRole = await roleRepo.create({ code: 'net_mgr_live', label: 'NM', isSystem: false });
  const managePerm = await permRepo.seed({ moduleCode: 'network', action: 'manage' });
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: login + '@x.com', login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('mgr-live');
  const noPermUser = await mkUser('np-live');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  // NAS seed: id=1 mikrotik_api, id=2 ubiquiti, id=3 radius_orchestrator (default InMemoryNasRepository)
  const nasRepo = new InMemoryNasRepository();

  // IP pool for NAS id=3 (radius_orchestrator)
  const ipNetworkRepo = new InMemoryIpNetworkRepository();
  (ipNetworkRepo as unknown as { pools: IpPool[] }).pools = [];
  ipNetworkRepo.seedPool({
    id: 'pool-seam', name: 'seam', networkId: 'n1',
    rangeStart: '10.10.0.1', rangeEnd: '10.10.0.100',
    type: 'dynamic', assignedCount: 0, totalCount: 100, nasId: '3', ipKind: null,
  });

  // 2 sessions in pool, 1 outside
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    globalSessions: [
      { sessionId: 'seam-1', username: 'c1', nasIp: '10.0.0.5', framedIp: '10.10.0.10', startedAt: '2026-06-20T12:00:00Z', bytesIn: 100, bytesOut: 200, callerId: null },
      { sessionId: 'seam-2', username: 'c2', nasIp: '10.0.0.5', framedIp: '10.10.0.20', startedAt: '2026-06-21T08:00:00Z', bytesIn: 100, bytesOut: 200, callerId: null },
      { sessionId: 'seam-3', username: 'c3', nasIp: '10.0.0.5', framedIp: '10.10.1.99', startedAt: '2026-06-01T00:00:00Z', bytesIn: 100, bytesOut: 200, callerId: null },
    ],
  });

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createNasRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListNasServers(nasRepo, ipNetworkRepo, orchestrator),
    new GetNasServer(nasRepo, ipNetworkRepo, orchestrator),
    new CreateNasServer(nasRepo),
    new UpdateNasServer(nasRepo),
    new DeleteNasServer(nasRepo),
    new GetRadiusConfig(nasRepo),
    new UpdateRadiusConfig(nasRepo),
  ));
  app.use(errorHandler);

  return { app, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

describe('nas.routes — live counters HTTP seam', () => {
  it('GET /api/nas-servers: NAS id=3 (radius_orchestrator) => displayType=BRAS RADIUS, clientCount=2', async () => {
    const { app, noPermUserId } = await buildAppWithLive();
    const res = await asUser(request(app).get('/api/nas-servers'), noPermUserId);
    expect(res.status).toBe(200);
    const radiusNas = res.body.find((n: { id: string }) => n.id === '3');
    expect(radiusNas).toBeDefined();
    expect(radiusNas.displayType).toBe('BRAS RADIUS');
    expect(radiusNas.clientCount).toBe(2);
  });

  it('GET /api/nas-servers/3 (radius_orchestrator): live clientCount + displayType', async () => {
    const { app, noPermUserId } = await buildAppWithLive();
    const res = await asUser(request(app).get('/api/nas-servers/3'), noPermUserId);
    expect(res.status).toBe(200);
    expect(res.body.displayType).toBe('BRAS RADIUS');
    expect(res.body.clientCount).toBe(2);
  });

  it('GET /api/nas-servers: NAS id=1 (mikrotik_api) => displayType=mikrotik_api (not BRAS RADIUS)', async () => {
    const { app, noPermUserId } = await buildAppWithLive();
    const res = await asUser(request(app).get('/api/nas-servers'), noPermUserId);
    expect(res.status).toBe(200);
    const legacyNas = res.body.find((n: { id: string }) => n.id === '1');
    expect(legacyNas).toBeDefined();
    expect(legacyNas.displayType).toBe('mikrotik_api');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// sqlippool-cleanup (REQ-DEL-1/2) — ruta pool-mode eliminada + poolName fuera del DTO
// ════════════════════════════════════════════════════════════════════════════

describe('nas.routes — sqlippool-cleanup (REQ-DEL-1/2)', () => {
  it('S1.2: POST /api/nas-servers/:id/pool-mode → 404 (ruta inexistente)', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/nas-servers/1/pool-mode').send({ poolName: 'asur-cgnat' });
    expect(res.status).toBe(404);
  });

  it('S2.1: GET /api/nas-servers → ningún item expone poolName', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/nas-servers'), noPermUserId);
    expect(res.status).toBe(200);
    expect(res.body.every((n: Record<string, unknown>) => !('poolName' in n))).toBe(true);
  });
});

describe('nas.routes — secret masking + update sentinel', () => {
  it('GET /api/nas-servers masks radiusSecret/apiPassword and never leaks the real secret', async () => {
    const { app, nasRepo, noPermUserId } = await buildApp();
    await nasRepo.updateNasServer('1', { radiusSecret: 'LEAK-RADIUS', apiPassword: 'LEAK-API' });
    const res = await asUser(request(app).get('/api/nas-servers'), noPermUserId);
    expect(res.status).toBe(200);
    const nas1 = res.body.find((n: { id: string }) => n.id === '1');
    expect(nas1.radiusSecret).toBe(NAS_SECRET_MASK);
    expect(nas1.apiPassword).toBe(NAS_SECRET_MASK);
    expect(JSON.stringify(res.body)).not.toContain('LEAK-RADIUS');
    expect(JSON.stringify(res.body)).not.toContain('LEAK-API');
  });

  it('GET /api/nas-servers/:id masks and never leaks the real secret', async () => {
    const { app, nasRepo, noPermUserId } = await buildApp();
    await nasRepo.updateNasServer('1', { radiusSecret: 'LEAK-RADIUS', apiPassword: 'LEAK-API' });
    const res = await asUser(request(app).get('/api/nas-servers/1'), noPermUserId);
    expect(res.status).toBe(200);
    expect(res.body.radiusSecret).toBe(NAS_SECRET_MASK);
    expect(res.body.apiPassword).toBe(NAS_SECRET_MASK);
    expect(JSON.stringify(res.body)).not.toContain('LEAK-RADIUS');
  });

  it('PUT /api/nas-servers/:id with the mask leaves the stored secret intact', async () => {
    const { app, nasRepo, manageUserId } = await buildApp();
    await nasRepo.updateNasServer('1', { radiusSecret: 'STORED-REAL' });
    const res = await asUser(request(app).put('/api/nas-servers/1'), manageUserId)
      .send({ radiusSecret: NAS_SECRET_MASK });
    expect(res.status).toBe(200);
    const stored = await nasRepo.findNasServerById('1');
    expect(stored!.radiusSecret).toBe('STORED-REAL');
  });

  it('PUT /api/nas-servers/:id with a real new secret updates the stored value', async () => {
    const { app, nasRepo, manageUserId } = await buildApp();
    await nasRepo.updateNasServer('1', { radiusSecret: 'STORED-REAL' });
    const res = await asUser(request(app).put('/api/nas-servers/1'), manageUserId)
      .send({ radiusSecret: 'NEW-REAL' });
    expect(res.status).toBe(200);
    const stored = await nasRepo.findNasServerById('1');
    expect(stored!.radiusSecret).toBe('NEW-REAL');
  });

  it('POST /api/nas-servers masks the secret in its own response but stores the real one', async () => {
    const { app, nasRepo, manageUserId } = await buildApp();
    const body = { name: 'nuevo', type: 'mikrotik_api', ipAddress: '10.9.9.9', radiusSecret: 'CREATE-REAL',
      nasIpAddress: '10.9.9.9', apiPort: 8728, apiLogin: 'admin', apiPassword: 'CREATE-API',
      status: 'active', lastSeen: null, clientCount: 0, description: '' };
    const res = await asUser(request(app).post('/api/nas-servers'), manageUserId).send(body);
    expect(res.status).toBe(201);
    expect(res.body.radiusSecret).toBe(NAS_SECRET_MASK);
    expect(res.body.apiPassword).toBe(NAS_SECRET_MASK);
    expect(JSON.stringify(res.body)).not.toContain('CREATE-REAL');
    expect(JSON.stringify(res.body)).not.toContain('CREATE-API');
    const stored = await nasRepo.findNasServerById(res.body.id);
    expect(stored!.radiusSecret).toBe('CREATE-REAL');
    expect(stored!.apiPassword).toBe('CREATE-API');
  });

  it('PUT /api/nas-servers/:id masks the secret in its own response but stores the new real one', async () => {
    const { app, nasRepo, manageUserId } = await buildApp();
    const res = await asUser(request(app).put('/api/nas-servers/1'), manageUserId).send({ radiusSecret: 'PUT-NEW-REAL' });
    expect(res.status).toBe(200);
    expect(res.body.radiusSecret).toBe(NAS_SECRET_MASK);
    expect(JSON.stringify(res.body)).not.toContain('PUT-NEW-REAL');
    const stored = await nasRepo.findNasServerById('1');
    expect(stored!.radiusSecret).toBe('PUT-NEW-REAL');
  });
});
