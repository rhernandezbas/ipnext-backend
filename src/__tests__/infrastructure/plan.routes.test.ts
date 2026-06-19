import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createPlanRouter } from '@infrastructure/http/routes/plan.routes';

import { ListPlans } from '@application/use-cases/ListPlans';
import { CreatePlan } from '@application/use-cases/CreatePlan';
import { UpdatePlan } from '@application/use-cases/UpdatePlan';
import { DeletePlan } from '@application/use-cases/DeletePlan';

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
  planRepo: InMemoryPlanRepository;
  manageUserId: string;
  readOnlyUserId: string;
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
    const roles = await Promise.all(roleIds.map(id => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
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

  const managerRole = await roleRepo.create({ code: 'plan_manager', label: 'Plan Manager', isSystem: false });
  const readerRole  = await roleRepo.create({ code: 'plan_reader',  label: 'Plan Reader',  isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'plan', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'plan', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: login + '@x.com', login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const noPermUser = await mkUser('noperm');

  const planRepo = new InMemoryPlanRepository();
  const gateway  = new InMemoryRadiusOrchestratorGateway();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api',
    createPlanRouter(
      new EchoAuthProvider(),
      undefined,
      requirePerm,
      new ListPlans(planRepo),
      new CreatePlan(planRepo, gateway),
      new UpdatePlan(planRepo, gateway),
      new DeletePlan(planRepo, gateway),
    ),
  );
  app.use(errorHandler);

  return { app, planRepo, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', 'auth_token=' + userId);
}

describe('GET /api/plans', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token => 401', async () => {
    const res = await request(fx.app).get('/api/plans');
    expect(res.status).toBe(401);
  });
  it('no plan.read => 403', async () => {
    const res = await asUser(request(fx.app).get('/api/plans'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
  it('with plan.read => 200 empty array', async () => {
    const res = await asUser(request(fx.app).get('/api/plans'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });
  it('returns plans with rateLimit field', async () => {
    await fx.planRepo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const res = await asUser(request(fx.app).get('/api/plans'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].rateLimit).toBe('10M/30M');
  });
});

describe('POST /api/plans', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token => 401', async () => {
    const res = await request(fx.app).post('/api/plans').send({ code: 'X', name: 'X', category: 'Air', downloadKbps: 1000, uploadKbps: 500 });
    expect(res.status).toBe(401);
  });
  it('plan.read only (no manage) => 403', async () => {
    const res = await asUser(request(fx.app).post('/api/plans'), fx.readOnlyUserId)
      .send({ code: 'X', name: 'X', category: 'Air', downloadKbps: 1000, uploadKbps: 500 });
    expect(res.status).toBe(403);
  });
  it('invalid body => 422', async () => {
    const res = await asUser(request(fx.app).post('/api/plans'), fx.manageUserId)
      .send({ code: '', name: 'X' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
  it('valid body => 201 with plan DTO', async () => {
    const res = await asUser(request(fx.app).post('/api/plans'), fx.manageUserId)
      .send({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('IP-Air-30-10');
    expect(res.body.status).toBe('enabled');
    expect(res.body.rateLimit).toBe('10M/30M');
  });
  it('duplicate code => 409 PLAN_CODE_TAKEN', async () => {
    await fx.planRepo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const res = await asUser(request(fx.app).post('/api/plans'), fx.manageUserId)
      .send({ code: 'IP-Air-30-10', name: 'Another', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_CODE_TAKEN');
  });
});

describe('PATCH /api/plans/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('valid update => 200 with updated plan', async () => {
    const plan = await fx.planRepo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const res = await asUser(request(fx.app).patch('/api/plans/' + plan.id), fx.manageUserId)
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(res.body.code).toBe('IP-Air-30-10');
  });
  it('unknown id => 404 PLAN_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).patch('/api/plans/nonexistent'), fx.manageUserId)
      .send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAN_NOT_FOUND');
  });
  it('empty body => 422', async () => {
    const res = await asUser(request(fx.app).patch('/api/plans/some-id'), fx.manageUserId)
      .send({});
    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/plans/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('valid id => 204', async () => {
    const plan = await fx.planRepo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const res = await asUser(request(fx.app).delete('/api/plans/' + plan.id), fx.manageUserId);
    expect(res.status).toBe(204);
  });
  it('unknown id => 404 PLAN_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).delete('/api/plans/nonexistent'), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAN_NOT_FOUND');
  });
});

// ── W2: OrchestratorRejectedError — el gateway colapsa 4xx y 5xx en el mismo error ─────────────
// El orchestrator puede rechazar peticiones con 4xx (ej. 403 = código reservado, 400 = kbps fuera
// de rango). Antes del fix, cualquier error del orchestrator se mapeaba a 502. Estos tests
// verifican que el error correcto llega al cliente.

async function buildAppWithRejection(rejectCode: string, rejectStatus: number, detail: string): Promise<Fixture & { gateway: InMemoryRadiusOrchestratorGateway }> {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map(id => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
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

  const managerRole = await roleRepo.create({ code: 'plan_manager2', label: 'Plan Manager', isSystem: false });
  const managePerm = await permRepo.seed({ moduleCode: 'plan', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'plan', action: 'read' });
  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const manageUser = await userRepo.create({ name: 'mgr2', email: 'mgr2@x.com', login: 'mgr2', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const planRepo = new InMemoryPlanRepository();
  const gateway = new InMemoryRadiusOrchestratorGateway({
    rejectPlanCode: [{ code: rejectCode, status: rejectStatus, detail }],
  });
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api',
    createPlanRouter(
      new EchoAuthProvider(),
      undefined,
      requirePerm,
      new ListPlans(planRepo),
      new CreatePlan(planRepo, gateway),
      new UpdatePlan(planRepo, gateway),
      new DeletePlan(planRepo, gateway),
    ),
  );
  app.use(errorHandler);

  return { app, planRepo, manageUserId: manageUser.id, readOnlyUserId: manageUser.id, noPermUserId: manageUser.id, gateway };
}

describe('W2 — OrchestratorRejectedError: 4xx del orchestrator NO debe mapearse a 502', () => {
  it('POST /api/plans con código reservado (_BLOCKED): orchestrator 403 → ruta devuelve 403, NO 502', async () => {
    const fx = await buildAppWithRejection('_BLOCKED', 403, 'plan code _BLOCKED is reserved');
    const res = await asUser(request(fx.app).post('/api/plans'), fx.manageUserId)
      .send({ code: '_BLOCKED', name: 'Blocked Plan', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 });
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(502);
    expect(res.body.code).toBe('ORCHESTRATOR_REJECTED');
  });

  it('POST /api/plans con kbps fuera de rango: orchestrator 400 → ruta devuelve 400, NO 502', async () => {
    const fx = await buildAppWithRejection('IP-Bad-Range', 400, 'download_kbps out of range');
    const res = await asUser(request(fx.app).post('/api/plans'), fx.manageUserId)
      .send({ code: 'IP-Bad-Range', name: 'Bad Range', category: 'Air', downloadKbps: 9999999, uploadKbps: 5000 });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(502);
    expect(res.body.code).toBe('ORCHESTRATOR_REJECTED');
  });

  it('POST /api/plans con código duplicado en RADIUS: orchestrator 409 → ruta devuelve 409, NO 502', async () => {
    const fx = await buildAppWithRejection('IP-Dup', 409, 'code conflict in RADIUS');
    const res = await asUser(request(fx.app).post('/api/plans'), fx.manageUserId)
      .send({ code: 'IP-Dup', name: 'Dup Plan', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORCHESTRATOR_REJECTED');
  });

  it('DELETE /api/plans/:id: orchestrator 404 (plan no existe en RADIUS) → ruta devuelve 404, NO 502', async () => {
    const fx = await buildAppWithRejection('IP-Gone', 404, 'plan not found in RADIUS');
    const plan = await fx.planRepo.upsertByCode({ code: 'IP-Gone', name: 'Gone Plan', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 });
    const res = await asUser(request(fx.app).delete('/api/plans/' + plan.id), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORCHESTRATOR_REJECTED');
  });

  it('POST /api/plans: el body del error incluye el motivo del rechazo', async () => {
    const fx = await buildAppWithRejection('_BLOCKED', 403, 'plan code _BLOCKED is reserved');
    const res = await asUser(request(fx.app).post('/api/plans'), fx.manageUserId)
      .send({ code: '_BLOCKED', name: 'Blocked Plan', category: 'Air', downloadKbps: 10000, uploadKbps: 5000 });
    expect(res.body.error).toContain('_BLOCKED is reserved');
  });
});
