/**
 * POST /api/alerts/ingest/:source (machine, apiKey POR FUENTE — F3), GET /api/alerts
 * (RBAC monitoring.read), POST /api/alerts/:id/acknowledge (RBAC
 * monitoring.acknowledge_alert). Patrón de fixture: accessPoints.routes.test.ts
 * (InMemory RBAC + requirePermission real).
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
import { createExternalWriteRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const FIBER_KEY = 'fiber-collector-test-key';
const GRAFANA_KEY = 'grafana-test-key';

// alerts.routes.ts → apiKeyMiddleware.ts imports @infrastructure/config, whose
// top-level validateEnv() process.exit(1)s without real SPLYNX_*/JWT_SECRET/PORT
// env vars. Mock it (same pattern as externalV1.routes.test.ts) — the router
// never reads config.* directly, the ingest keys come from `deps.ingestKeys`.
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

interface Fixture {
  app: express.Express;
  repo: InMemoryNocAlertRepository;
  flagRepo: InMemoryFeatureFlagRepository;
  acknowledgeAlert: AcknowledgeAlert;
  readUserId: string;
  ackUserId: string;
  noPermUserId: string;
}

interface BuildAppOpts {
  /** Defaults to seeded ON — most tests exercise the hub with the kill-switch enabled. */
  hubEnabled?: boolean;
  /** Override for F7's rate-limit test (tiny window/limit instead of the 30/min default). */
  ingestRateLimiterOpts?: { windowMs?: number; limit?: number };
}

async function buildApp(opts: BuildAppOpts = {}): Promise<Fixture> {
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
  const ackRole = await roleRepo.create({ code: 'noc_ack', label: 'NOC Ack', isSystem: false });
  const plainRole = await roleRepo.create({ code: 'noc_none', label: 'NOC None', isSystem: false });

  const readPerm = await permRepo.seed({ moduleCode: 'monitoring', action: 'read' });
  const ackPerm = await permRepo.seed({ moduleCode: 'monitoring', action: 'acknowledge_alert' });
  await rolePermRepo.grant(readRole.id, readPerm.id);
  await rolePermRepo.grant(ackRole.id, ackPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readRole.id);
  const ackUser = await mkUser('acker');
  await userRoleRepo.assign(ackUser.id, ackRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, plainRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const repo = new InMemoryNocAlertRepository();
  const publisher = new NoOpAlertEventPublisher();
  const ingestAlert = new IngestAlert(repo, publisher);
  const listAlerts = new ListAlerts(repo);
  const acknowledgeAlert = new AcknowledgeAlert(repo);

  const flagRepo = new InMemoryFeatureFlagRepository();
  if (opts.hubEnabled !== false) {
    flagRepo.seed('noc-alerts-hub-enabled', true);
  } else {
    flagRepo.seed('noc-alerts-hub-enabled', false);
  }

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/alerts',
    createAlertsRouter({
      ingestAlert,
      listAlerts,
      acknowledgeAlert,
      ingestKeys: { 'fiber-collector': FIBER_KEY, grafana: GRAFANA_KEY },
      featureFlagRepo: flagRepo,
      ingestRateLimiter: opts.ingestRateLimiterOpts
        ? createExternalWriteRateLimiter(opts.ingestRateLimiterOpts)
        : undefined,
      auth: createAuthMiddleware(new EchoAuthProvider()),
      requirePerm,
    }),
  );
  app.use(errorHandler);

  return { app, repo, flagRepo, acknowledgeAlert, readUserId: readUser.id, ackUserId: ackUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

function validIngestBody(overrides: Record<string, unknown> = {}) {
  return {
    source: 'fiber-collector',
    fingerprint: 'onu-abc-signal-critical',
    status: 'firing',
    alertname: 'ONU signal critical',
    severity: 'critical',
    entity: { type: 'onu', name: 'ONU-abc' },
    message: 'Señal óptica crítica en ONU-abc',
    startsAt: '2026-07-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('POST /api/alerts/ingest/:source', () => {
  it('sin X-API-Key → 401 y no se crea ningún NocAlert', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app).post('/api/alerts/ingest/fiber-collector').send(validIngestBody());

    expect(res.status).toBe(401);
    expect(await repo.list({})).toHaveLength(0);
  });

  it('con key inválida → 401 y no se crea ningún NocAlert', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', 'wrong-key')
      .send(validIngestBody());

    expect(res.status).toBe(401);
    expect(await repo.list({})).toHaveLength(0);
  });

  it('con key válida → crea el NocAlert (201, DTO)', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody());

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('firing');
    expect(res.body).not.toHaveProperty('fingerprint');
    expect(await repo.list({})).toHaveLength(1);
  });

  // F3 — fuente desconocida en el path → 404, ANTES de comparar cualquier key.
  it('source desconocido en el path → 404', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/not-a-real-source')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody());

    expect(res.status).toBe(404);
  });

  // F3 — CRÍTICO (spoofing): la key de fiber-collector NO debe servir para postear
  // como grafana. Antes de este fix, `source` salía del BODY (no del path), así que
  // con la fiber key alguien podía mandar `source:"grafana"` y colarse.
  it('F3 — la key de fiber-collector NO sirve para /ingest/grafana (401)', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/grafana')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ source: 'grafana' }));

    expect(res.status).toBe(401);
    expect(await repo.list({})).toHaveLength(0);
  });

  // F3 — el :source del PATH manda; un `source` distinto en el body se ignora.
  it('F3 — el source del PATH gana sobre el source del body', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ source: 'grafana' })); // body dice grafana, path dice fiber-collector

    expect(res.status).toBe(201);
    expect(res.body.source).toBe('fiber-collector');
    const stored = await repo.list({});
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source).toBe('fiber-collector');
  });

  // F1 — startsAt inválido (no parseable) debe rechazarse ANTES de llegar a Prisma
  // (antes: pasaba la validación de "string no vacío" y reventaba `new Date()` en
  // el repo con un 500 opaco).
  it('F1 — startsAt no parseable como fecha → 400 (no 500)', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ startsAt: 'ayer' }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await repo.list({})).toHaveLength(0);
  });

  it('F1 — endsAt no parseable como fecha → 400', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ status: 'resolved', endsAt: 'mañana' }));

    expect(res.status).toBe(400);
    expect(await repo.list({})).toHaveLength(0);
  });

  it('F1 — startsAt válido sigue aceptándose (no regresión)', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ startsAt: '2026-07-24T10:00:00.000Z' }));

    expect(res.status).toBe(201);
  });

  // F2 — metric.value no numérico debe rechazarse ANTES de llegar a la columna Float de Prisma.
  it('F2 — metric.value no numérico → 400 (no 500)', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ metric: { name: 'signal', value: 'critico', unit: 'dBm' } }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await repo.list({})).toHaveLength(0);
  });

  it('F2 — threshold no numérico → 400', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ threshold: 'muy-bajo' }));

    expect(res.status).toBe(400);
    expect(await repo.list({})).toHaveLength(0);
  });

  it('F2 — metric.value numérico válido sigue aceptándose', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/fiber-collector')
      .set('X-API-Key', FIBER_KEY)
      .send(validIngestBody({ metric: { name: 'signal', value: -32, unit: 'dBm' }, threshold: -30 }));

    expect(res.status).toBe(201);
    expect(res.body.metricValue).toBe(-32);
    expect(res.body.threshold).toBe(-30);
  });

  // F5 — kill-switch noc-alerts-hub-enabled.
  describe('F5 — kill-switch noc-alerts-hub-enabled', () => {
    it('flag OFF → 503, no se crea ningún NocAlert', async () => {
      const { app, repo } = await buildApp({ hubEnabled: false });

      const res = await request(app)
        .post('/api/alerts/ingest/fiber-collector')
        .set('X-API-Key', FIBER_KEY)
        .send(validIngestBody());

      expect(res.status).toBe(503);
      expect(await repo.list({})).toHaveLength(0);
    });

    it('flag ON → 201 normal (no regresión)', async () => {
      const { app } = await buildApp({ hubEnabled: true });

      const res = await request(app)
        .post('/api/alerts/ingest/fiber-collector')
        .set('X-API-Key', FIBER_KEY)
        .send(validIngestBody());

      expect(res.status).toBe(201);
    });
  });

  // F7 — rate limiter dedicado (reusa createExternalWriteRateLimiter, molde external write).
  it('F7 — rate limiter aplicado: request de más devuelve 429', async () => {
    const { app } = await buildApp({ ingestRateLimiterOpts: { windowMs: 60_000, limit: 2 } });

    const send = () =>
      request(app)
        .post('/api/alerts/ingest/fiber-collector')
        .set('X-API-Key', FIBER_KEY)
        .send(validIngestBody());

    const r1 = await send();
    const r2 = await send();
    const r3 = await send();

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r3.status).toBe(429);
  });
});

describe('GET /api/alerts', () => {
  it('sin monitoring.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/alerts'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('sin auth → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(401);
  });

  it('con monitoring.read → 200, lista filtrada por source+severity+status como DTO', async () => {
    const { app, repo, readUserId } = await buildApp();
    await repo.upsertByFingerprint(
      { ...validIngestBody({ fingerprint: 'fp-a', severity: 'critical', status: 'firing' }) } as any,
    );
    await repo.upsertByFingerprint(
      { ...validIngestBody({ fingerprint: 'fp-b', severity: 'warning', status: 'firing' }) } as any,
    );

    const res = await asUser(
      request(app).get('/api/alerts?source=fiber-collector&severity=critical&status=firing'),
      readUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].fingerprint).toBeUndefined();
    expect(res.body.data[0].severity).toBe('critical');
  });

  // F6 — filtro inválido debía ser IGNORADO antes (devolvía TODO); ahora → 400.
  it('F6 — severity inválida (bogus) → 400', async () => {
    const { app, repo, readUserId } = await buildApp();
    await repo.upsertByFingerprint({ ...validIngestBody({ fingerprint: 'fp-a' }) } as any);

    const res = await asUser(request(app).get('/api/alerts?severity=bogus'), readUserId);

    expect(res.status).toBe(400);
  });

  it('F6 — status inválido (bogus) → 400', async () => {
    const { app, repo, readUserId } = await buildApp();
    await repo.upsertByFingerprint({ ...validIngestBody({ fingerprint: 'fp-a' }) } as any);

    const res = await asUser(request(app).get('/api/alerts?status=bogus'), readUserId);

    expect(res.status).toBe(400);
  });
});

describe('POST /api/alerts/:id/acknowledge', () => {
  it('sin monitoring.acknowledge_alert → 403 y el use-case NO se invoca', async () => {
    const { app, repo, acknowledgeAlert, noPermUserId } = await buildApp();
    const alert = await repo.upsertByFingerprint(validIngestBody() as any);
    const spy = jest.spyOn(acknowledgeAlert, 'execute');

    const res = await asUser(request(app).post(`/api/alerts/${alert.id}/acknowledge`), noPermUserId);

    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('con permiso → 200 y setea ackBy/ackAt', async () => {
    const { app, repo, ackUserId } = await buildApp();
    const alert = await repo.upsertByFingerprint(validIngestBody() as any);

    const res = await asUser(request(app).post(`/api/alerts/${alert.id}/acknowledge`), ackUserId);

    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(res.body.ackBy).toBeTruthy();
  });

  it('id inexistente → 404', async () => {
    const { app, ackUserId } = await buildApp();

    const res = await asUser(request(app).post('/api/alerts/does-not-exist/acknowledge'), ackUserId);

    expect(res.status).toBe(404);
  });
});
