/**
 * POST /api/alerts/ingest/grafana — Fase B (`noc-alert-grafana-source`). Recibe
 * el shape REAL del webhook de Grafana Alerting (`{status, alerts: [...]}`,
 * NO el shape canónico que usa fiber-collector) y lo mapea vía
 * `GrafanaWebhookSource` antes de delegar al MISMO `IngestAlert` que ya cubre
 * alerts.routes.test.ts. B7 — auth 401/rate-limit/kill-switch YA están
 * cubiertos genéricamente en alerts.routes.test.ts (con la key de
 * fiber-collector) — acá solo se cubre lo NUEVO: mapeo del shape de Grafana,
 * sobre malformado→400 vía la ruta real, y N alertas agrupadas→N filas.
 *
 * FIX WAVE (review adversarial de B) — decisión revisada: la ingesta de un
 * webhook agrupado ya NO es atómica. Un elemento individual malformado
 * (F-B3) o un fallo del repo aislado a UN elemento (F-B2) ya no tumban el
 * batch entero ni devuelven 400/500 con la persistencia parcial oculta —
 * cada elemento se procesa en aislamiento y se reporta (`results`), 201 si
 * todo salió bien, 207 si hubo algún skip/error mezclado con éxitos.
 * `fingerprint` ausente (F-B4) ya no es un caso de error — se deriva.
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
import { GrafanaWebhookSource } from '@infrastructure/adapters/grafana/GrafanaWebhookSource';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';

import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const GRAFANA_KEY = 'grafana-test-key';
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
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);
  void permRepo;
  void rolePermRepo;

  const repo = new InMemoryNocAlertRepository();
  const publisher = new NoOpAlertEventPublisher();
  const ingestAlert = new IngestAlert(repo, publisher);
  const listAlerts = new ListAlerts(repo);
  const acknowledgeAlert = new AcknowledgeAlert(repo);
  const flagRepo = new InMemoryFeatureFlagRepository();
  flagRepo.seed('noc-alerts-hub-enabled', true);
  const grafanaSource = new GrafanaWebhookSource();

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
      grafanaSource,
      auth: createAuthMiddleware(new EchoAuthProvider()),
      requirePerm,
    }),
  );
  app.use(errorHandler);

  return { app, repo };
}

function grafanaWebhook(overrides: Record<string, unknown> = {}) {
  return {
    status: 'firing',
    commonLabels: { alertname: 'BgpPeerDown' },
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'BgpPeerDown', router: 'core-1' },
        annotations: { description: 'BGP peer down', runbook_url: 'https://runbooks.ipnext/bgp' },
        startsAt: '2026-07-24T10:00:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
        fingerprint: 'grafana-fp-1',
        generatorURL: 'https://grafana.ipnext/d/bgp',
      },
    ],
    ...overrides,
  };
}

describe('POST /api/alerts/ingest/grafana — B5 mapeo + delegación a IngestAlert', () => {
  it('firing crea un NocAlert con source: grafana', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/grafana')
      .set('X-API-Key', GRAFANA_KEY)
      .send(grafanaWebhook());

    expect(res.status).toBe(201);
    const stored = await repo.list({});
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source).toBe('grafana');
    expect(stored[0]?.status).toBe('firing');
    expect(stored[0]?.fingerprint).toBe('grafana-fp-1');
    expect(stored[0]?.alertname).toBe('BgpPeerDown');
    expect(stored[0]?.entityName).toBe('core-1');
  });

  it('resolved cierra el NocAlert firing existente con el mismo fingerprint (source: grafana)', async () => {
    const { app, repo } = await buildApp();

    await request(app).post('/api/alerts/ingest/grafana').set('X-API-Key', GRAFANA_KEY).send(grafanaWebhook());

    const res = await request(app)
      .post('/api/alerts/ingest/grafana')
      .set('X-API-Key', GRAFANA_KEY)
      .send(
        grafanaWebhook({
          status: 'resolved',
          alerts: [
            {
              status: 'resolved',
              labels: { alertname: 'BgpPeerDown', router: 'core-1' },
              annotations: { description: 'BGP peer down' },
              startsAt: '2026-07-24T10:00:00.000Z',
              endsAt: '2026-07-24T10:15:00.000Z',
              fingerprint: 'grafana-fp-1',
              generatorURL: 'https://grafana.ipnext/d/bgp',
            },
          ],
        }),
      );

    expect(res.status).toBe(201);
    const stored = await repo.list({});
    expect(stored).toHaveLength(1); // misma fila, no una segunda
    expect(stored[0]?.status).toBe('resolved');
    expect(stored[0]?.endsAt).toBe('2026-07-24T10:15:00.000Z');
  });

  it('payload malformado (sin alerts) → 400, no crea ningún NocAlert', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/grafana')
      .set('X-API-Key', GRAFANA_KEY)
      .send({ status: 'firing' });

    expect(res.status).toBe(400);
    expect(await repo.list({})).toHaveLength(0);
  });

  // F-B4 (fix wave) — decisión revisada: fingerprint ausente YA NO es
  // malformado, se deriva uno estable. Este test antes esperaba 400; ahora
  // el elemento se ingiere igual (201), con un fingerprint derivado.
  it('elemento sin fingerprint → 201, se ingiere con un fingerprint derivado (F-B4, no 400)', async () => {
    const { app, repo } = await buildApp();
    const bodyOk = grafanaWebhook();
    const okAlerts = bodyOk['alerts'] as Array<Record<string, unknown>>;
    delete okAlerts[0]?.['fingerprint'];

    const res = await request(app).post('/api/alerts/ingest/grafana').set('X-API-Key', GRAFANA_KEY).send(bodyOk);

    expect(res.status).toBe(201);
    const stored = await repo.list({});
    expect(stored).toHaveLength(1);
    expect(typeof stored[0]?.fingerprint).toBe('string');
    expect(stored[0]?.fingerprint.length).toBeGreaterThan(0);
  });

  // F-B3 (fix wave, MEDIUM) — decisión revisada: un elemento estructuralmente
  // inválido (status inválido) ya NO tira todo el webhook a 400 — se
  // SKIPPEA + reporta, el resto del batch se ingiere igual.
  it('un elemento con status inválido en un batch de 5 → los 4 válidos se ingieren (207), el inválido se reporta skipped', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/grafana')
      .set('X-API-Key', GRAFANA_KEY)
      .send({
        status: 'firing',
        alerts: [
          { status: 'firing', labels: { alertname: 'HighCpu', router: 'r0' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-0' },
          { status: 'firing', labels: { alertname: 'HighCpu', router: 'r1' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-1' },
          { status: 'firing', labels: { alertname: 'HighCpu', router: 'r2' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-2' },
          { status: 'bogus-status', labels: { alertname: 'HighCpu', router: 'r3' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-3' },
          { status: 'firing', labels: { alertname: 'HighCpu', router: 'r4' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-4' },
        ],
      });

    expect(res.status).toBe(207);
    const stored = await repo.list({});
    expect(stored).toHaveLength(4);
    expect(stored.map((a) => a.fingerprint).sort()).toEqual(['fp-0', 'fp-1', 'fp-2', 'fp-4']);

    const body = res.body as { data: unknown[]; results: Array<{ index: number; status: string; fingerprint?: string; error?: string }> };
    expect(body.data).toHaveLength(4);
    expect(body.results).toHaveLength(5);
    const skippedResult = body.results.find((r) => r.index === 3);
    expect(skippedResult?.status).toBe('skipped');
    expect(skippedResult?.error).toMatch(/status/i);
    const okResults = body.results.filter((r) => r.status === 'ok');
    expect(okResults).toHaveLength(4);
  });

  // F-B2 (fix wave, HIGH — fan-out parcial) — un fallo del REPO al ingerir
  // UN elemento (no un problema de mapeo) no debe tumbar a sus hermanos ni
  // devolver un 500 pelado con persistencia parcial oculta.
  it('el repo tira en el 2º elemento de 3 → los otros 2 se persisten Y la respuesta reporta el fallo del 2º (no 500 pelado)', async () => {
    const roleRepo = new InMemoryRbacRoleRepository();
    const userRoleRepo = new InMemoryRbacUserRoleRepository();
    const permRepo = new InMemoryRbacPermissionRepository();
    const rolePermRepo = new InMemoryRbacRolePermissionRepository();
    const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
    const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);
    void permRepo;
    void rolePermRepo;

    const realRepo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();

    // Wrapper: throws for ONE specific fingerprint, delegates the rest to the
    // real in-memory repo — simulates a transient repo failure isolated to a
    // single element.
    const flakyRepo: typeof realRepo = Object.assign(Object.create(Object.getPrototypeOf(realRepo)), realRepo);
    const originalUpsert = realRepo.upsertByFingerprint.bind(realRepo);
    flakyRepo.upsertByFingerprint = async (input) => {
      if (input.fingerprint === 'fp-boom') {
        throw new Error('simulated repo failure for fp-boom');
      }
      return originalUpsert(input);
    };

    const ingestAlert = new IngestAlert(flakyRepo, publisher);
    const listAlerts = new ListAlerts(realRepo);
    const acknowledgeAlert = new AcknowledgeAlert(realRepo);
    const flagRepo = new InMemoryFeatureFlagRepository();
    flagRepo.seed('noc-alerts-hub-enabled', true);
    const grafanaSource = new GrafanaWebhookSource();

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
        grafanaSource,
        auth: createAuthMiddleware(new EchoAuthProvider()),
        requirePerm,
      }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/alerts/ingest/grafana')
      .set('X-API-Key', GRAFANA_KEY)
      .send({
        status: 'firing',
        alerts: [
          { status: 'firing', labels: { alertname: 'HighCpu', router: 'r0' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-ok-1' },
          { status: 'firing', labels: { alertname: 'HighCpu', router: 'r1' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-boom' },
          { status: 'firing', labels: { alertname: 'HighCpu', router: 'r2' }, annotations: {}, startsAt: '2026-07-24T10:00:00.000Z', fingerprint: 'fp-ok-2' },
        ],
      });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(207);

    const stored = await realRepo.list({});
    expect(stored).toHaveLength(2);
    expect(stored.map((a) => a.fingerprint).sort()).toEqual(['fp-ok-1', 'fp-ok-2']);

    const body = res.body as { data: unknown[]; results: Array<{ index: number; status: string; fingerprint?: string; error?: string }> };
    expect(body.data).toHaveLength(2);
    const boomResult = body.results.find((r) => r.fingerprint === 'fp-boom');
    expect(boomResult?.status).toBe('error');
    expect(boomResult?.error).toMatch(/fp-boom/i);
  });

  // B4 — grouped webhook con 2 elementos de fingerprint distinto.
  it('webhook agrupado con 2 alertas de fingerprint distinto → 2 NocAlert creados', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app)
      .post('/api/alerts/ingest/grafana')
      .set('X-API-Key', GRAFANA_KEY)
      .send(
        grafanaWebhook({
          alerts: [
            {
              status: 'firing',
              labels: { alertname: 'HighCpu', router: 'r1' },
              annotations: { description: 'CPU alta' },
              startsAt: '2026-07-24T10:00:00.000Z',
              fingerprint: 'fp-a',
            },
            {
              status: 'firing',
              labels: { alertname: 'HighMemory', router: 'r2' },
              annotations: { description: 'Memoria alta' },
              startsAt: '2026-07-24T10:00:00.000Z',
              fingerprint: 'fp-b',
            },
          ],
        }),
      );

    expect(res.status).toBe(201);
    const stored = await repo.list({});
    expect(stored).toHaveLength(2);
    const fingerprints = stored.map((a) => a.fingerprint).sort();
    expect(fingerprints).toEqual(['fp-a', 'fp-b']);
  });

  // B7 — no reespecifica auth 401 (ya cubierta en alerts.routes.test.ts), solo
  // un smoke check de que la key de grafana efectivamente guarda ESTA ruta.
  it('sin X-API-Key → 401, no crea ningún NocAlert', async () => {
    const { app, repo } = await buildApp();

    const res = await request(app).post('/api/alerts/ingest/grafana').send(grafanaWebhook());

    expect(res.status).toBe(401);
    expect(await repo.list({})).toHaveLength(0);
  });
});
