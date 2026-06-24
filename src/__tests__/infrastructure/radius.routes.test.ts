/**
 * radius.routes.test.ts — sesiones RADIUS + guard de seguridad.
 *
 * /api/radius estaba SIN auth ni permiso (agujero; fix `network-routes-guard`).
 * `network.read` para listar; `network.manage` para desconectar.
 *
 * FIX4: listRadiusEvents y listNe8000Audit ahora son REQUERIDOS en createRadiusRouter.
 * Todos los buildApp() les pasan instancias in-memory.
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

import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';
import { ListRadiusEvents } from '@application/use-cases/ListRadiusEvents';
import { ListNe8000PppoeAudit } from '@application/use-cases/ListNe8000PppoeAudit';
import { ListRadiusAuthFailures } from '@application/use-cases/ListRadiusAuthFailures';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

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
  readUserId: string;
  manageUserId: string;
  noPermUserId: string;
  pppoeRepo: InMemoryPppoeServiceRepository;
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

  // FIX4: listRadiusEvents y listNe8000Audit ahora son REQUERIDOS
  const radiusEventRepo     = new InMemoryRadiusEventRepository();
  const radiusAuthEventRepo = new InMemoryRadiusAuthEventRepository();
  const pppoeRepo           = new InMemoryPppoeServiceRepository();
  const nasRepo             = new InMemoryNasRepository();

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
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, manageUserId: manageUser.id, noPermUserId: noPermUser.id, pppoeRepo };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('radius.routes — sesiones + security guard (network.read / network.manage)', () => {
  it('GET /api/radius/sessions sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/radius/sessions')).status).toBe(401);
  });
  it('GET /api/radius/sessions sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    expect((await asUser(request(app).get('/api/radius/sessions'), noPermUserId)).status).toBe(403);
  });
  it('GET /api/radius/sessions con network.read → 200 con 15 sesiones', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions'), readUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(15);
  });

  it('GET /api/radius/sessions → sesión con PPPoE+contrato trae contractId/clientId/customerName; sin PPPoE → null (seam ruta + use case real)', async () => {
    const { app, readUserId, pppoeRepo } = await buildApp();
    // El seed in-memory de sesiones usa user1@ipnext.com.ar (session-1) y user2@ipnext.com.ar (session-2).
    await pppoeRepo.upsertByUsername({
      username: 'user1@ipnext.com.ar',
      password: 'secret',
      nasId: 'nas-1',
      contractId: 'contract-1',
    });
    pppoeRepo.setContractClient('contract-1', 'client-1', 'Juan Pérez');

    const res = await asUser(request(app).get('/api/radius/sessions'), readUserId);
    expect(res.status).toBe(200);

    const s1 = res.body.find((s: any) => s.username === 'user1@ipnext.com.ar');
    expect(s1).toBeDefined();
    expect(s1.contractId).toBe('contract-1');
    expect(s1.clientId).toBe('client-1');
    expect(s1.customerName).toBe('Juan Pérez');

    // user2 no tiene PppoeService sembrado → los 3 en null (FE muestra ⚠).
    const s2 = res.body.find((s: any) => s.username === 'user2@ipnext.com.ar');
    expect(s2).toBeDefined();
    expect(s2.contractId).toBeNull();
    expect(s2.clientId).toBeNull();
    expect(s2.customerName).toBeNull();
  });

  it('DELETE /api/radius/sessions/:id sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).delete('/api/radius/sessions/session-1')).status).toBe(401);
  });
  it('DELETE /api/radius/sessions/:id sin network.manage (solo read) → 403', async () => {
    const { app, readUserId } = await buildApp();
    expect((await asUser(request(app).delete('/api/radius/sessions/session-1'), readUserId)).status).toBe(403);
  });
  it('DELETE /api/radius/sessions/:id con network.manage → 200 { success: true }', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).delete('/api/radius/sessions/session-1'), manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── radius events + audit routes ─────────────────────────────────────────────

async function buildAuditApp(): Promise<{ app: express.Express; readUserId: string; noPermUserId: string; authEventRepo: InMemoryRadiusAuthEventRepository }> {
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

  const readerRole = await roleRepo.create({ code: 'network_reader2', label: 'Network Reader 2', isSystem: false });
  const readPerm   = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader2');
  const noPermUser = await mkUser('noperm2');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const radiusEventRepo     = new InMemoryRadiusEventRepository();
  const radiusAuthEventRepo = new InMemoryRadiusAuthEventRepository();
  const pppoeRepo           = new InMemoryPppoeServiceRepository();
  const nasRepo             = new InMemoryNasRepository();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/radius', createRadiusRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListRadiusSessions(new InMemoryRadiusSessionRepository(), pppoeRepo),
    new DisconnectSession(new InMemoryRadiusSessionRepository()),
    new ListRadiusEvents(radiusEventRepo),
    new ListNe8000PppoeAudit(pppoeRepo, radiusEventRepo, nasRepo),
    new ListRadiusAuthFailures(radiusAuthEventRepo),
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, noPermUserId: noPermUser.id, authEventRepo: radiusAuthEventRepo };
}

describe('radius.routes — /events + /ne8000/audit (network audit)', () => {
  it('GET /api/radius/events sin auth → 401', async () => {
    const { app } = await buildAuditApp();
    expect((await request(app).get('/api/radius/events')).status).toBe(401);
  });

  it('GET /api/radius/events sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildAuditApp();
    expect((await asUser(request(app).get('/api/radius/events'), noPermUserId)).status).toBe(403);
  });

  it('GET /api/radius/events con network.read → 200 (lista vacia)', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/radius/events?eventType=invalid → 400', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?eventType=invalid'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/radius/ne8000/audit sin auth → 401', async () => {
    const { app } = await buildAuditApp();
    expect((await request(app).get('/api/radius/ne8000/audit')).status).toBe(401);
  });

  it('GET /api/radius/ne8000/audit con network.read → 200', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/ne8000/audit'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  // ── FIX5: validación de inputs numéricos y fechas ─────────────────────────────

  it('FIX5: GET /events?page=abc → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?page=abc'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /events?limit=abc → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?limit=xyz'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /events?vlanId=abc → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?vlanId=notanumber'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /events?from=notadate → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?from=notadate'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /events?to=notadate → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?to=notadate'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /ne8000/audit?page=abc → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/ne8000/audit?page=abc'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /ne8000/audit?limit=abc → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/ne8000/audit?limit=xyz'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /events?page=0 → 400 VALIDATION_ERROR (no positivo)', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?page=0'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX5: GET /events con params válidos → 200', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/events?page=1&limit=10&vlanId=3713&from=2026-06-01T00:00:00Z&to=2026-06-22T00:00:00Z'), readUserId);
    expect(res.status).toBe(200);
  });
});

// ─── radius auth-failures route (radpostauth) ──────────────────────────────────

describe('radius.routes — /auth-failures (network audit)', () => {
  it('GET /api/radius/auth-failures sin auth → 401', async () => {
    const { app } = await buildAuditApp();
    expect((await request(app).get('/api/radius/auth-failures')).status).toBe(401);
  });

  it('GET /api/radius/auth-failures sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildAuditApp();
    expect((await asUser(request(app).get('/api/radius/auth-failures'), noPermUserId)).status).toBe(403);
  });

  it('GET /api/radius/auth-failures con network.read → 200 (lista vacia)', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/auth-failures'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /auth-failures devuelve eventos sembrados ordenados authdate DESC (seam ruta + use case real + repo in-memory)', async () => {
    const { app, readUserId, authEventRepo } = await buildAuditApp();
    await authEventRepo.upsertMany([
      { sourceUniqueId: 'pa-1', username: 'c001', reply: 'Access-Reject', authdate: new Date('2026-06-01T10:00:00Z'), class: null },
      { sourceUniqueId: 'pa-2', username: 'c002', reply: 'Access-Accept', authdate: new Date('2026-06-20T10:00:00Z'), class: 'X' },
    ]);
    const res = await asUser(request(app).get('/api/radius/auth-failures'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data[0].username).toBe('c002'); // más reciente primero
    expect(res.body.data[0].reply).toBe('Access-Accept');
    expect(res.body.data[0]).not.toHaveProperty('sourceUniqueId');
  });

  it('GET /auth-failures?reply=Access-Reject filtra (seam ruta + use case real)', async () => {
    const { app, readUserId, authEventRepo } = await buildAuditApp();
    await authEventRepo.upsertMany([
      { sourceUniqueId: 'pa-1', username: 'c001', reply: 'Access-Reject', authdate: new Date('2026-06-01T10:00:00Z'), class: null },
      { sourceUniqueId: 'pa-2', username: 'c002', reply: 'Access-Accept', authdate: new Date('2026-06-20T10:00:00Z'), class: null },
    ]);
    const res = await asUser(request(app).get('/api/radius/auth-failures?reply=Access-Reject'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].reply).toBe('Access-Reject');
  });

  it('GET /auth-failures?reply=invalid → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/auth-failures?reply=Nope'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /auth-failures?page=abc → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/auth-failures?page=abc'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /auth-failures?from=notadate → 400 VALIDATION_ERROR', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/auth-failures?from=notadate'), readUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /auth-failures con params válidos → 200', async () => {
    const { app, readUserId } = await buildAuditApp();
    const res = await asUser(request(app).get('/api/radius/auth-failures?page=1&limit=10&reply=Access-Reject&from=2026-06-01T00:00:00Z&to=2026-06-22T00:00:00Z'), readUserId);
    expect(res.status).toBe(200);
  });
});
