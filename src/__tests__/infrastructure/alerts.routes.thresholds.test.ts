/**
 * alerts.routes.thresholds.test.ts — F1 (noc-alerts-config, lado BE).
 *
 * `GET /api/alerts/thresholds` — auth DUAL: `fiberIngestKey` (Bearer/X-API-Key,
 * el colector Rust) O sesión-cookie + `monitoring.manage` (panel FE).
 * `PUT /api/alerts/thresholds` — SOLO sesión-cookie + `monitoring.manage`
 * (la vía machine es read-only — spec.md "Fiber collector cannot edit
 * thresholds via its API key").
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createAlertsRouter } from '@infrastructure/http/routes/alerts.routes';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { GetAlertThresholds } from '@application/use-cases/alerts/GetAlertThresholds';
import { UpdateAlertThresholds } from '@application/use-cases/alerts/UpdateAlertThresholds';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { InMemoryNocAlertThresholdsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertThresholdsConfigRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const FIBER_KEY = 'fiber-collector-test-key';

jest.mock('@infrastructure/config', () => ({
  config: { externalApi: { apiKey: '' }, alerts: { grafanaIngestKey: '', fiberIngestKey: '' } },
}));

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

async function buildApp() {
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
        const p = allPerms.find((ap) => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  const manageRole = await roleRepo.create({ code: 'noc_manage', label: 'NOC Manage', isSystem: false });
  const plainRole = await roleRepo.create({ code: 'noc_none', label: 'NOC None', isSystem: false });
  const managePerm = await permRepo.seed({ moduleCode: 'monitoring', action: 'manage' });
  await rolePermRepo.grant(manageRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, manageRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, plainRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const repo = new InMemoryNocAlertRepository();
  const publisher = new NoOpAlertEventPublisher();
  const ingestAlert = new IngestAlert(repo, publisher);
  const listAlerts = new ListAlerts(repo);
  const acknowledgeAlert = new AcknowledgeAlert(repo, publisher);
  const thresholdsRepo = new InMemoryNocAlertThresholdsConfigRepository();
  const getAlertThresholds = new GetAlertThresholds(thresholdsRepo);
  const updateAlertThresholds = new UpdateAlertThresholds(thresholdsRepo);

  const flagRepo = new InMemoryFeatureFlagRepository();
  flagRepo.seed('noc-alerts-hub-enabled', true);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/alerts',
    createAlertsRouter({
      ingestAlert,
      listAlerts,
      acknowledgeAlert,
      getAlertThresholds,
      updateAlertThresholds,
      ingestKeys: { 'fiber-collector': FIBER_KEY, grafana: 'gk' },
      featureFlagRepo: flagRepo,
      auth: createAuthMiddleware(new EchoAuthProvider()),
      requirePerm,
    }),
  );
  app.use(errorHandler);

  return { app, thresholdsRepo, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

const DEFAULTS = { critDbm: -30, warnDbm: -27, deltaAlert: 2.0, ponMinAbon: 2, ponDelta: 1.5 };

describe('GET /api/alerts/thresholds', () => {
  it('con fiberIngestKey (Bearer) → 200 con los defaults, shape flat sin envelope', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/alerts/thresholds').set('Authorization', `Bearer ${FIBER_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  it('con fiberIngestKey (X-API-Key) → 200', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/alerts/thresholds').set('X-API-Key', FIBER_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  it('con sesión + monitoring.manage → 200', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/alerts/thresholds'), manageUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  it('con sesión SIN monitoring.manage → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/alerts/thresholds'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('sin cookie de sesión NI fiberIngestKey válida → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/alerts/thresholds');
    expect(res.status).toBe(401);
  });

  it('fiberIngestKey inválida y sin sesión → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/alerts/thresholds').set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/alerts/thresholds', () => {
  it('con monitoring.manage → 200, actualiza, y un GET posterior refleja los nuevos valores', async () => {
    const { app, manageUserId } = await buildApp();
    const putRes = await asUser(request(app).put('/api/alerts/thresholds'), manageUserId).send({
      critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });

    const getRes = await asUser(request(app).get('/api/alerts/thresholds'), manageUserId);
    expect(getRes.body).toEqual({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });
  });

  it('sin monitoring.manage → 403, el singleton NO cambia', async () => {
    const { app, noPermUserId, thresholdsRepo } = await buildApp();
    const res = await asUser(request(app).put('/api/alerts/thresholds'), noPermUserId).send({
      critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0,
    });
    expect(res.status).toBe(403);
    expect(await thresholdsRepo.get()).toEqual(DEFAULTS);
  });

  it('vía fiberIngestKey (machine) → rechazado (401), el singleton NO cambia', async () => {
    const { app, thresholdsRepo } = await buildApp();
    const res = await request(app)
      .put('/api/alerts/thresholds')
      .set('Authorization', `Bearer ${FIBER_KEY}`)
      .send({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });
    expect([401, 403]).toContain(res.status);
    expect(await thresholdsRepo.get()).toEqual(DEFAULTS);
  });

  it('payload con un campo faltante → 400, sin actualización parcial', async () => {
    const { app, manageUserId, thresholdsRepo } = await buildApp();
    const res = await asUser(request(app).put('/api/alerts/thresholds'), manageUserId).send({
      critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3,
      // ponDelta missing
    });
    expect(res.status).toBe(400);
    expect(await thresholdsRepo.get()).toEqual(DEFAULTS);
  });

  it('payload con un valor no numérico → 400, sin actualización parcial', async () => {
    const { app, manageUserId, thresholdsRepo } = await buildApp();
    const res = await asUser(request(app).put('/api/alerts/thresholds'), manageUserId).send({
      critDbm: '-28', warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0,
    });
    expect(res.status).toBe(400);
    expect(await thresholdsRepo.get()).toEqual(DEFAULTS);
  });
});
