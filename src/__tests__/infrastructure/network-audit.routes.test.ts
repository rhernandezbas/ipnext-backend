/**
 * network-audit.routes.test.ts — TDD RED → GREEN
 *
 * Rutas de auditoría de red (network.read):
 *   GET /api/radius/events       → ListRadiusEvents
 *   GET /api/radius/ne8000/audit → ListNe8000PppoeAudit
 *
 * Estrategia: supertest + repos in-memory inyectados.
 * NO se mockea el use case — se testea el SEAM COMPLETO
 * query → ruta → use case → repo (lección #28).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createRadiusRouter } from '@infrastructure/http/routes/radius.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { ListNe8000PppoeAudit } from '@application/use-cases/ListNe8000PppoeAudit';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// ── EchoAuthProvider (misma que en radius.routes.test.ts) ─────────────────────
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

const NE8000_IP = '10.75.0.30';

// ── fixture ───────────────────────────────────────────────────────────────────
interface Fixture {
  app: express.Express;
  readUserId: string;
  noPermUserId: string;
  radiusRepo: InMemoryRadiusEventRepository;
  pppoeRepo: InMemoryPppoeServiceRepository;
  nasRepo: InMemoryNasRepository;
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

  const readerRole = await roleRepo.create({ code: 'net_reader', label: 'Net Reader', isSystem: false });
  const readPerm   = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  // repos
  const radiusRepo  = new InMemoryRadiusEventRepository();
  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const nasRepo     = new InMemoryNasRepository();
  const sessionRepo = new InMemoryRadiusSessionRepository();

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  // use cases
  const listRadiusSessions = new ListRadiusSessions(sessionRepo);
  const disconnectSession  = new DisconnectSession(sessionRepo);
  const listRadiusEvents   = new ListRadiusEvents(radiusRepo);
  const listNe8000Audit    = new ListNe8000PppoeAudit(pppoeRepo, radiusRepo, nasRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/radius', createRadiusRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    listRadiusSessions,
    disconnectSession,
    listRadiusEvents,
    listNe8000Audit,
  ));
  app.use(errorHandler);

  return {
    app,
    readUserId:  readUser.id,
    noPermUserId: noPermUser.id,
    radiusRepo,
    pppoeRepo,
    nasRepo,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ── tests GET /api/radius/events ──────────────────────────────────────────────
describe('GET /api/radius/events', () => {
  it('sin auth → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/radius/events');
    expect(res.status).toBe(401);
  });

  it('sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/events'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con network.read y sin datos → 200 con lista vacía', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/events'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
    expect(res.body.hasNext).toBe(false);
  });

  it('devuelve datos con la paginación correcta', async () => {
    const { app, readUserId, radiusRepo } = await buildApp();

    await radiusRepo.upsertMany([{
      sourceUniqueId: 'uid-1',
      username:       'c001',
      nasIpAddress:   NE8000_IP,
      nasId:          'nas-1',
      framedIp:       null,
      macAddress:     null,
      vlanId:         3713,
      startedAt:      new Date('2026-06-01T10:00:00Z'),
      stoppedAt:      null,
      sessionTime:    null,
      bytesIn:        BigInt(1024),
      bytesOut:       BigInt(2048),
      eventType:      'start',
      status:         'online',
    }]);

    const res = await asUser(request(app).get('/api/radius/events'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('c001');
    expect(res.body.data[0].vlanId).toBe(3713);
    expect(typeof res.body.data[0].inOctets).toBe('string');
  });

  // SEAM completo: el filtro viaja query → ruta → use case → repo
  it('SEAM: ?username=c001 filtra correctamente (ruta → use case → repo)', async () => {
    const { app, readUserId, radiusRepo } = await buildApp();

    await radiusRepo.upsertMany([
      {
        sourceUniqueId: 'uid-c001',
        username:       'c001',
        nasIpAddress:   NE8000_IP,
        nasId:          'nas-1',
        framedIp:       null,
        macAddress:     null,
        vlanId:         null,
        startedAt:      new Date('2026-06-01T10:00:00Z'),
        stoppedAt:      null,
        sessionTime:    null,
        bytesIn:        BigInt(0),
        bytesOut:       BigInt(0),
        eventType:      'start',
        status:         'online',
      },
      {
        sourceUniqueId: 'uid-c002',
        username:       'c002',
        nasIpAddress:   NE8000_IP,
        nasId:          'nas-1',
        framedIp:       null,
        macAddress:     null,
        vlanId:         null,
        startedAt:      new Date('2026-06-02T10:00:00Z'),
        stoppedAt:      null,
        sessionTime:    null,
        bytesIn:        BigInt(0),
        bytesOut:       BigInt(0),
        eventType:      'start',
        status:         'online',
      },
    ]);

    const res = await asUser(
      request(app).get('/api/radius/events').query({ username: 'c001' }),
      readUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].username).toBe('c001');
  });

  it('SEAM: ?page=1&limit=1 pagina correctamente (ruta → use case → repo)', async () => {
    const { app, readUserId, radiusRepo } = await buildApp();

    await radiusRepo.upsertMany([
      {
        sourceUniqueId: 'uid-p1',
        username:       'u1',
        nasIpAddress:   NE8000_IP,
        nasId:          'nas-1',
        framedIp:       null, macAddress: null, vlanId: null,
        startedAt:      new Date('2026-06-01T10:00:00Z'),
        stoppedAt:      null, sessionTime: null,
        bytesIn: BigInt(0), bytesOut: BigInt(0),
        eventType: 'start', status: 'online',
      },
      {
        sourceUniqueId: 'uid-p2',
        username:       'u2',
        nasIpAddress:   NE8000_IP,
        nasId:          'nas-1',
        framedIp:       null, macAddress: null, vlanId: null,
        startedAt:      new Date('2026-06-02T10:00:00Z'),
        stoppedAt:      null, sessionTime: null,
        bytesIn: BigInt(0), bytesOut: BigInt(0),
        eventType: 'start', status: 'online',
      },
    ]);

    const res = await asUser(
      request(app).get('/api/radius/events').query({ page: '1', limit: '1' }),
      readUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(2);
    expect(res.body.hasNext).toBe(true);
  });

  // REQ-FILTER-8: eventType inválido → 400
  it('?eventType=invalid → 400', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(
      request(app).get('/api/radius/events').query({ eventType: 'unknown' }),
      readUserId,
    );
    expect(res.status).toBe(400);
  });
});

// ── tests GET /api/radius/ne8000/audit ────────────────────────────────────────
describe('GET /api/radius/ne8000/audit', () => {
  it('sin auth → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/radius/ne8000/audit');
    expect(res.status).toBe(401);
  });

  it('sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/ne8000/audit'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con network.read y sin datos → 200 con lista vacía', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/ne8000/audit'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('devuelve datos del NE8000 correctamente', async () => {
    const { app, readUserId, pppoeRepo, nasRepo } = await buildApp();

    const ne8000 = await nasRepo.createNasServer({
      name: 'NE8000-1', type: 'huawei_radius',
      ipAddress: NE8000_IP, radiusSecret: 'sec',
      nasIpAddress: NE8000_IP, apiPort: null,
      apiLogin: null, apiPassword: null,
      status: 'active', lastSeen: null,
      clientCount: 0, description: 'NE8000 BRAS',
    });

    await pppoeRepo.upsertByUsername({
      username: 'ne-client', password: 'secret',
      profile: 'Plan-100M', remoteAddress: null,
      status: 'enabled', nasId: ne8000.id,
      contractId: null, enforcedState: 'active',
    });

    const res = await asUser(request(app).get('/api/radius/ne8000/audit'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('ne-client');
    expect('password' in res.body.data[0]).toBe(false);
  });

  // SEAM: ?username filtra (ruta → use case → repo)
  it('SEAM: ?username=ne filtra correctamente', async () => {
    const { app, readUserId, pppoeRepo, nasRepo } = await buildApp();

    const ne8000 = await nasRepo.createNasServer({
      name: 'NE8000-1', type: 'huawei_radius',
      ipAddress: NE8000_IP, radiusSecret: 'sec',
      nasIpAddress: NE8000_IP, apiPort: null,
      apiLogin: null, apiPassword: null,
      status: 'active', lastSeen: null,
      clientCount: 0, description: 'NE8000 BRAS',
    });

    await pppoeRepo.upsertByUsername({
      username: 'ne-client-a', password: 'sec',
      profile: null, remoteAddress: null,
      status: 'enabled', nasId: ne8000.id,
      contractId: null, enforcedState: 'active',
    });
    await pppoeRepo.upsertByUsername({
      username: 'other-client', password: 'sec',
      profile: null, remoteAddress: null,
      status: 'enabled', nasId: ne8000.id,
      contractId: null, enforcedState: 'active',
    });

    const res = await asUser(
      request(app).get('/api/radius/ne8000/audit').query({ username: 'ne-client' }),
      readUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].username).toBe('ne-client-a');
  });

  // REQ-FILTER-3: status inválido → 400
  it('?status=invalid → 400', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(
      request(app).get('/api/radius/ne8000/audit').query({ status: 'terminated' }),
      readUserId,
    );
    expect(res.status).toBe(400);
  });

  // REQ-FILTER-4: enforcedState inválido → 400
  it('?enforcedState=invalid → 400', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(
      request(app).get('/api/radius/ne8000/audit').query({ enforcedState: 'unknown' }),
      readUserId,
    );
    expect(res.status).toBe(400);
  });
});
