/**
 * radius.sessionCures.routes.test.ts — GET/POST /api/radius/session-cures
 * (radius-session-autocure BE-1, REQ-CURE-5/6). Molde radius.routes.test.ts (auth-failures):
 * mismo guard network.read (GET) / network.manage (POST) + validación defensiva.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createRadiusRouter } from '@infrastructure/http/routes/radius.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryRadiusSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusSessionCureEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionCureEventRepository';

import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { ListNe8000PppoeAudit } from '@application/use-cases/ListNe8000PppoeAudit';
import { ListRadiusAuthFailures } from '@application/use-cases/ListRadiusAuthFailures';
import { ListRadiusSessionCures } from '@application/use-cases/ListRadiusSessionCures';
import { CureStuckSession } from '@application/use-cases/CureStuckSession';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';

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
    return { id: token, username: `user-${token}`, email: 'test@test.com', role: 'admin' };
  }
}

const CURE_TUNING = { staleMs: 1_200_000, persistenceMs: 300_000, recencyMs: 120_000 };

function session(username: string, over: Partial<OrchestratorSession> = {}): OrchestratorSession {
  return {
    sessionId: `sid-${username}`, username, nasIp: '10.60.0.10', framedIp: '100.64.10.10',
    startedAt: '2026-07-16T09:00:00Z', bytesIn: 0, bytesOut: 0, callerId: null,
    lastUpdate: '2026-07-16T11:30:00Z', // 30min stale por default
    ...over,
  };
}

async function buildApp(extraSessions: Record<string, OrchestratorSession[]> = {}) {
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

  const readerRole  = await roleRepo.create({ code: 'network_reader', label: 'Network Reader', isSystem: false });
  const managerRole = await roleRepo.create({ code: 'network_manager', label: 'Network Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'network', action: 'manage' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader');
  const manageUser = await mkUser('manager');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const repo = new InMemoryRadiusSessionRepository();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const radiusEventRepo     = new InMemoryRadiusEventRepository();
  const radiusAuthEventRepo = new InMemoryRadiusAuthEventRepository();
  const pppoeRepo           = new InMemoryPppoeServiceRepository();
  const nasRepo             = new InMemoryNasRepository();
  const cureEventRepo       = new InMemoryRadiusSessionCureEventRepository();
  const gateway             = new InMemoryRadiusOrchestratorGateway({
    seed: [
      { username: 'clienteStale', sessions: [session('clienteStale')] },
      ...Object.entries(extraSessions).map(([username, sessions]) => ({ username, sessions })),
    ],
  });
  const cureStuckSession    = new CureStuckSession(gateway, cureEventRepo, CURE_TUNING);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/radius', createRadiusRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListRadiusSessions(repo, pppoeRepo),
    new DisconnectSession(repo),
    new ListRadiusEvents(radiusEventRepo),
    new ListNe8000PppoeAudit(pppoeRepo, radiusEventRepo, nasRepo),
    new ListRadiusAuthFailures(radiusAuthEventRepo),
    new ListRadiusSessionCures(cureEventRepo),
    cureStuckSession,
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, manageUserId: manageUser.id, noPermUserId: noPermUser.id, cureEventRepo, gateway };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/radius/session-cures (network.read)', () => {
  it('sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/radius/session-cures')).status).toBe(401);
  });

  it('S5.5: sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    expect((await asUser(request(app).get('/api/radius/session-cures'), noPermUserId)).status).toBe(403);
  });

  it('S5.3: con network.read → 200, wire contract campo por campo + countsByOutcome', async () => {
    const { app, readUserId, cureEventRepo } = await buildApp();
    await cureEventRepo.record({ username: 'u1', trigger: 'auto', outcome: 'cured', signalUsed: 'persistent_rejects', actorName: 'sistema' });
    await cureEventRepo.record({ username: 'u2', trigger: 'auto', outcome: 'skipped_alive', actorName: 'sistema' });

    const res = await asUser(request(app).get('/api/radius/session-cures'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.countsByOutcome.cured).toBe(1);
    expect(res.body.countsByOutcome.skipped_alive).toBe(1);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('hasNext');
  });

  it('?outcome=cured filtra data pero countsByOutcome trae el desglose completo', async () => {
    const { app, readUserId, cureEventRepo } = await buildApp();
    await cureEventRepo.record({ username: 'u1', trigger: 'auto', outcome: 'cured', actorName: 'sistema' });
    await cureEventRepo.record({ username: 'u2', trigger: 'auto', outcome: 'skipped_alive', actorName: 'sistema' });

    const res = await asUser(request(app).get('/api/radius/session-cures?outcome=cured'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.countsByOutcome.skipped_alive).toBe(1);
  });

  it('S5.4: outcome inválido → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/session-cures?outcome=bogus'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('S5.4: page no numérica → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/session-cures?page=abc'), readUserId);
    expect(res.status).toBe(400);
  });

  it('S5.4: fecha rota → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/session-cures?from=not-a-date'), readUserId);
    expect(res.status).toBe(400);
  });

  it('trigger inválido → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/session-cures?trigger=bogus'), readUserId);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/radius/session-cures (network.manage, S6.1-S6.6)', () => {
  it('S6.4: sin auth → 401, sin network.manage → 403, CERO filas', async () => {
    const { app, readUserId, cureEventRepo } = await buildApp();
    expect((await request(app).post('/api/radius/session-cures').send({ username: 'clienteStale' })).status).toBe(401);
    const res = await asUser(request(app).post('/api/radius/session-cures').send({ username: 'clienteStale' }), readUserId);
    expect(res.status).toBe(403);
    expect(cureEventRepo.all()).toHaveLength(0);
  });

  it('S6.1: manual sin force sobre sesión stale → 200 {outcome:cured} + fila con actorName del operador', async () => {
    const { app, manageUserId, cureEventRepo } = await buildApp();
    const res = await asUser(request(app).post('/api/radius/session-cures').send({ username: 'clienteStale' }), manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('cured');
    expect(cureEventRepo.all()[0]?.trigger).toBe('manual');
    expect(cureEventRepo.all()[0]?.actorName).toBeTruthy();
  });

  it('sin username seedeado → 0 sesiones abiertas → 200 skipped_no_session (NO 409, ese gate es distinto de alive)', async () => {
    const { app, manageUserId, cureEventRepo } = await buildApp();
    const res = await asUser(
      request(app).post('/api/radius/session-cures').send({ username: 'clienteInexistente' }),
      manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('skipped_no_session');
    expect(cureEventRepo.all().some((e) => e.outcome === 'skipped_no_session')).toBe(true);
  });

  it('S6.2: manual sin force sobre sesión con interim fresco → 409 CURE_SKIPPED_ALIVE + fila skipped_alive trigger manual', async () => {
    const { app, manageUserId, cureEventRepo } = await buildApp({
      clienteFresco: [session('clienteFresco', { lastUpdate: '2026-07-16T11:59:30Z' })], // 30s fresco
    });
    const res = await asUser(
      request(app).post('/api/radius/session-cures').send({ username: 'clienteFresco' }),
      manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CURE_SKIPPED_ALIVE');
    const row = cureEventRepo.all().find((e) => e.username === 'clienteFresco');
    expect(row?.outcome).toBe('skipped_alive');
    expect(row?.trigger).toBe('manual');
  });

  it('S6.2b: manual sin force con sesiones en NAS distintos → 409 CURE_SKIPPED_AMBIGUOUS', async () => {
    const { app, manageUserId } = await buildApp({
      clienteAmbiguo: [
        session('clienteAmbiguo', { sessionId: 's1', nasIp: '10.60.0.10' }),
        session('clienteAmbiguo', { sessionId: 's2', nasIp: '10.60.0.20' }),
      ],
    });
    const res = await asUser(
      request(app).post('/api/radius/session-cures').send({ username: 'clienteAmbiguo' }),
      manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CURE_SKIPPED_AMBIGUOUS');
  });

  it('S6.3: manual con force:true sobre sesión fresca → 200 cured + fila con reason forced', async () => {
    const { app, manageUserId, cureEventRepo } = await buildApp({
      clienteFresco3: [session('clienteFresco3', { lastUpdate: '2026-07-16T11:59:30Z' })],
    });
    const res = await asUser(
      request(app).post('/api/radius/session-cures').send({ username: 'clienteFresco3', force: true }),
      manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('cured');
    const row = cureEventRepo.all().find((e) => e.username === 'clienteFresco3');
    expect(row?.reason).toBe('forced');
  });

  it('validación: username ausente → 400 VALIDATION_ERROR', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/radius/session-cures').send({}), manageUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('S6.5: dos manuales seguidos del mismo username → AMBOS registran fila (sin throttle)', async () => {
    const { app, manageUserId, cureEventRepo } = await buildApp();
    await asUser(request(app).post('/api/radius/session-cures').send({ username: 'clienteStale' }), manageUserId);
    // La sesión ya se curó y se fue del listSessions in-memory → segunda llamada da skipped_no_session,
    // pero AMBAS deben registrar fila igual (sin throttle en manual).
    await asUser(request(app).post('/api/radius/session-cures').send({ username: 'clienteStale' }), manageUserId);
    expect(cureEventRepo.all().filter((e) => e.username === 'clienteStale')).toHaveLength(2);
  });
});
