/**
 * alerts.routes.ingestState.test.ts — Fase 1 (`noc-alerts-level-reconciliation`,
 * BE) — `GET /api/alerts/ingest/:source/state`.
 *
 * Expone el estado ANUNCIADO (`firing`) de UNA fuente, para que el colector Rust
 * (`ipnext-noc-collector`) reconcilie por nivel sin recordar flancos en memoria
 * (spec.md `noc-alert-announced-state`). Auth DUAL, mismo molde que
 * `createThresholdsReadAuth` sobre `GET /thresholds`, pero SCOPEADA por fuente:
 * la key de `fiber-collector` NUNCA sirve para leer el estado de `grafana`
 * (mínimo privilegio — design.md Decision 1).
 *
 * Respuesta: array PLANO, SIN envelope `{data}` (mismo criterio que
 * `/thresholds`, evita el mismatch de shape ya documentado). Proyección mínima:
 * `{fingerprint, severity, startsAt, acknowledged}`.
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
const GRAFANA_KEY = 'grafana-test-key';

// alerts.routes.ts → apiKeyMiddleware.ts importa @infrastructure/config, cuyo
// validateEnv() top-level process.exit(1)ea sin env vars reales — se mockea
// (mismo patrón que el resto de la suite de alerts.routes).
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

interface BuildAppOpts {
  /** Defaults to seeded ON — most tests exercise the endpoint with the kill-switch enabled. */
  hubEnabled?: boolean;
  /** Defaults to `{ 'fiber-collector': FIBER_KEY, grafana: GRAFANA_KEY }`. Override to test an empty configured key. */
  ingestKeys?: Record<string, string>;
}

async function buildApp(opts: BuildAppOpts = {}) {
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

  const readRole = await roleRepo.create({ code: 'noc_reader', label: 'NOC Reader', isSystem: false });
  const plainRole = await roleRepo.create({ code: 'noc_none', label: 'NOC None', isSystem: false });
  const readPerm = await permRepo.seed({ moduleCode: 'monitoring', action: 'read' });
  await rolePermRepo.grant(readRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, plainRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const repo = new InMemoryNocAlertRepository();
  const publisher = new NoOpAlertEventPublisher();
  const ingestAlert = new IngestAlert(repo, publisher);
  const listAlerts = new ListAlerts(repo);
  const acknowledgeAlert = new AcknowledgeAlert(repo, publisher);

  const flagRepo = new InMemoryFeatureFlagRepository();
  flagRepo.seed('noc-alerts-hub-enabled', opts.hubEnabled !== false);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/alerts',
    createAlertsRouter({
      ingestAlert,
      listAlerts,
      acknowledgeAlert,
      ingestKeys: opts.ingestKeys ?? { 'fiber-collector': FIBER_KEY, grafana: GRAFANA_KEY },
      featureFlagRepo: flagRepo,
      auth: createAuthMiddleware(new EchoAuthProvider()),
      requirePerm,
    }),
  );
  app.use(errorHandler);

  return { app, repo, flagRepo, readUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

function validIngestBody(overrides: Record<string, unknown> = {}) {
  return {
    source: 'fiber-collector',
    fingerprint: 'olt-level/onu-los/GPON00B904C1',
    status: 'firing',
    alertname: 'ONU LOS',
    severity: 'warning',
    entity: { type: 'onu', name: 'GPON00B904C1' },
    message: 'LOS fresh en ONU GPON00B904C1',
    startsAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('GET /api/alerts/ingest/:source/state', () => {
  describe('Requirement: Machine read access scoped por fuente', () => {
    it('con la ingest key de la fuente (Bearer) → 200 con el estado anunciado de esa fuente', async () => {
      const { app, repo } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody() as any);

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('Authorization', `Bearer ${FIBER_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          fingerprint: 'olt-level/onu-los/GPON00B904C1',
          severity: 'warning',
          startsAt: '2026-07-27T10:00:00.000Z',
          acknowledged: false,
        },
      ]);
    });

    it('con la ingest key de la fuente (X-API-Key) → 200', async () => {
      const { app, repo } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody() as any);

      const res = await request(app).get('/api/alerts/ingest/fiber-collector/state').set('X-API-Key', FIBER_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('la key de OTRA fuente (grafana) NO sirve para leer fiber-collector → 401', async () => {
      const { app, repo } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody() as any);

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('Authorization', `Bearer ${GRAFANA_KEY}`);

      expect([401, 403]).toContain(res.status);
    });

    it('fuente desconocida → 404 con código UNKNOWN_INGEST_SOURCE, ANTES de comparar key alguna', async () => {
      const { app } = await buildApp();

      const res = await request(app)
        .get('/api/alerts/ingest/inventada/state')
        .set('Authorization', 'Bearer whatever');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNKNOWN_INGEST_SOURCE');
    });

    it('sin credenciales → 401', async () => {
      const { app } = await buildApp();

      const res = await request(app).get('/api/alerts/ingest/fiber-collector/state');

      expect(res.status).toBe(401);
    });

    it('key configurada como cadena vacía → falla cerrado (401), sin sesión', async () => {
      const { app } = await buildApp({ ingestKeys: { 'fiber-collector': '', grafana: GRAFANA_KEY } });

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', '');

      expect(res.status).toBe(401);
    });

    it('sesión + monitoring.read → 200 (dual-auth, mismo molde que GET /thresholds)', async () => {
      const { app, repo, readUserId } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody() as any);

      const res = await asUser(request(app).get('/api/alerts/ingest/fiber-collector/state'), readUserId);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('sesión SIN monitoring.read → 403', async () => {
      const { app, noPermUserId } = await buildApp();

      const res = await asUser(request(app).get('/api/alerts/ingest/fiber-collector/state'), noPermUserId);

      expect(res.status).toBe(403);
    });
  });

  describe('Requirement: Proyección mínima, solo firing, sin envelope', () => {
    it('solo se devuelven las firing (no las resolved) de esa fuente', async () => {
      const { app, repo } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody({ fingerprint: 'fp-firing-1' }) as any);
      await repo.upsertByFingerprint(validIngestBody({ fingerprint: 'fp-firing-2' }) as any);
      await repo.upsertByFingerprint(
        validIngestBody({ fingerprint: 'fp-resolved-1', status: 'resolved', endsAt: '2026-07-27T11:00:00.000Z' }) as any,
      );

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', FIBER_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((a: { fingerprint: string }) => a.fingerprint).sort()).toEqual(['fp-firing-1', 'fp-firing-2']);
    });

    it('alertas firing de OTRA fuente quedan fuera', async () => {
      const { app, repo } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody({ fingerprint: 'fp-fiber' }) as any);
      await repo.upsertByFingerprint(validIngestBody({ source: 'grafana', fingerprint: 'fp-grafana' }) as any);

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', FIBER_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].fingerprint).toBe('fp-fiber');
    });

    it('el body es un array en la raíz, sin propiedad `data`', async () => {
      const { app, repo } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody() as any);

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', FIBER_KEY);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.data).toBeUndefined();
    });

    it('estado anunciado vacío → 200 con []', async () => {
      const { app } = await buildApp();

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', FIBER_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('el ACK del operador viaja en la proyección (acknowledged: true)', async () => {
      const { app, repo } = await buildApp();
      const alert = await repo.upsertByFingerprint(validIngestBody() as any);
      await repo.acknowledge(alert.id, 'operador', '2026-07-27T10:05:00.000Z');

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', FIBER_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          fingerprint: 'olt-level/onu-los/GPON00B904C1',
          severity: 'warning',
          startsAt: '2026-07-27T10:00:00.000Z',
          acknowledged: true,
        },
      ]);
    });

    it('la proyección NO incluye message/entity/explanation ni otros campos', async () => {
      const { app, repo } = await buildApp();
      await repo.upsertByFingerprint(validIngestBody() as any);

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', FIBER_KEY);

      expect(Object.keys(res.body[0]).sort()).toEqual(['acknowledged', 'fingerprint', 'severity', 'startsAt']);
    });
  });

  describe('Requirement: Ruta de solo lectura', () => {
    it('con el hub deshabilitado (noc-alerts-hub-enabled=false) → 503 NOC_ALERTS_HUB_DISABLED', async () => {
      const { app } = await buildApp({ hubEnabled: false });

      const res = await request(app)
        .get('/api/alerts/ingest/fiber-collector/state')
        .set('X-API-Key', FIBER_KEY);

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NOC_ALERTS_HUB_DISABLED');
    });
  });
});
