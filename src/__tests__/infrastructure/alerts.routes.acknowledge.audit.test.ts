/**
 * alerts.routes.acknowledge.audit.test.ts — F2 (noc-alerts-config, lado BE).
 *
 * Verifica el viaje completo: `POST /:id/acknowledge` (panel) + un
 * `auditMutationsMiddleware` REAL montado delante del router (como en
 * app.ts) escriben EXACTAMENTE UNA fila de auditoría — la ESTRUCTURADA que
 * `AcknowledgeAlert` graba directo (entityType='NocAlert', entityId, actor,
 * canal=panel) — NUNCA la fila genérica duplicada (action=null).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createAlertsRouter } from '@infrastructure/http/routes/alerts.routes';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { auditMutationsMiddleware } from '@infrastructure/http/middleware/auditMutationsMiddleware';

import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { NocAlert } from '@domain/entities/nocAlert';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

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
    return { id: token, username: 'acker', email: 'acker@test.com', role: 'admin' };
  }
}

function seedAlert(repo: InMemoryNocAlertRepository): NocAlert {
  const alert: NocAlert = {
    id: 'alert-1',
    source: 'grafana',
    fingerprint: 'fp-1',
    alertname: 'BGP peer down',
    severity: 'critical',
    status: 'firing',
    entityType: 'bgp_peer',
    entityName: 'peer-rda2',
    entityRef: null,
    metricName: null,
    metricValue: null,
    metricUnit: null,
    threshold: null,
    message: 'BGP peer down',
    explanation: null,
    link: null,
    startsAt: '2026-07-24T10:00:00.000Z',
    firstSeen: '2026-07-24T10:00:00.000Z',
    lastSeen: '2026-07-24T10:00:00.000Z',
    endsAt: null,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    acknowledged: false,
    ackBy: null,
    ackAt: null,
    ackNote: null,
    escalationState: null,
    telegramChatId: null,
    telegramMessageId: null,
  };
  repo.seed(alert);
  return alert;
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

  const ackRole = await roleRepo.create({ code: 'noc_ack', label: 'NOC Ack', isSystem: false });
  const ackPerm = await permRepo.seed({ moduleCode: 'monitoring', action: 'acknowledge_alert' });
  await rolePermRepo.grant(ackRole.id, ackPerm.id);

  const pwHash = await hasher.hash('pw');
  const ackUser = await userRepo.create({ name: 'acker', email: 'acker@x.com', login: 'acker', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(ackUser.id, ackRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const repo = new InMemoryNocAlertRepository();
  seedAlert(repo);
  const publisher = new NoOpAlertEventPublisher();
  const auditRepo = new InMemoryAuditEventRepository();
  const ingestAlert = new IngestAlert(repo, publisher);
  const listAlerts = new ListAlerts(repo);
  const acknowledgeAlert = new AcknowledgeAlert(repo, publisher, undefined, auditRepo);

  const flagRepo = new InMemoryFeatureFlagRepository();
  flagRepo.seed('noc-alerts-hub-enabled', true);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  // Molde app.ts: auditMutationsMiddleware montado GLOBAL, ANTES del router.
  app.use(auditMutationsMiddleware(auditRepo));
  app.use(
    '/api/alerts',
    createAlertsRouter({
      ingestAlert,
      listAlerts,
      acknowledgeAlert,
      ingestKeys: { 'fiber-collector': 'fk', grafana: 'gk' },
      featureFlagRepo: flagRepo,
      auth: createAuthMiddleware(new EchoAuthProvider()),
      requirePerm,
    }),
  );
  app.use(errorHandler);

  return { app, auditRepo, ackUserId: ackUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('POST /api/alerts/:id/acknowledge — auditoría estructurada, sin doble-fila (F2)', () => {
  it('escribe EXACTAMENTE UNA fila de auditoría (la estructurada), no la genérica duplicada', async () => {
    const { app, auditRepo, ackUserId } = await buildApp();

    const res = await asUser(request(app).post('/api/alerts/alert-1/acknowledge'), ackUserId).send({});
    await flush();

    expect(res.status).toBe(200);
    const page = await auditRepo.list({});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      action: 'alert.acknowledge',
      entityType: 'NocAlert',
      entityId: 'alert-1',
      actorLogin: 'acker',
    });
  });
});
