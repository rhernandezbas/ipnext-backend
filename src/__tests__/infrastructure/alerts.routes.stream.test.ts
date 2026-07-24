/**
 * GET /api/alerts/stream — C6-C13 (`noc-alert-realtime`, Fase C). spec.md
 * Testing Notes: "supertest no soporta streams reales fácilmente — usar el
 * patrón de leer chunks del `res` crudo (`http.request`/`node:http` directo)
 * ... NO mockear `EventEmitter`, usar el real". This file drives every
 * assertion over a REAL `http.Server` + raw `http.get`, reading chunks off
 * the socket directly, and always destroys the client request + closes the
 * server at the end of each test so nothing hangs (SSE never closes on its
 * own).
 *
 * Heartbeat (C12): tested with REAL timers + an injectable
 * `heartbeatIntervalMs` override (same established pattern as F7's
 * `ingestRateLimiter` override in `alerts.routes.test.ts`), NOT
 * `jest.useFakeTimers()` — mixing fake JS timers with a real OS socket is
 * flaky (libuv's poll phase isn't controlled by Jest's timer mock), so a
 * short real interval + a bounded real wait is the more reliable choice here.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createAlertsRouter } from '@infrastructure/http/routes/alerts.routes';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { AlertEventBus } from '@infrastructure/events/AlertEventBus';
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
import type { NocAlert } from '@domain/entities/nocAlert';
import type { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

/**
 * F-C1 (fix wave, MEDIUM) — fake que SIEMPRE rechaza, a diferencia de
 * `InMemoryFeatureFlagRepository` que nunca rechaza. Simula un hipo de DB
 * (Prisma) durante `GET /stream`: el handler async NO tenía `next`/try-catch,
 * así que este reject quedaba como unhandledRejection y la respuesta NUNCA se
 * mandaba (cliente colgado hasta timeout).
 */
class RejectingFeatureFlagRepository implements FeatureFlagRepository {
  async list(): Promise<FeatureFlag[]> {
    throw new Error('DB hipó (list)');
  }
  async get(): Promise<FeatureFlag | null> {
    throw new Error('DB hipó (get)');
  }
  async setEnabled(): Promise<FeatureFlag> {
    throw new Error('DB hipó (setEnabled)');
  }
}

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

function makeAlert(overrides: Partial<NocAlert> = {}): NocAlert {
  return {
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
    ...overrides,
  };
}

interface Fixture {
  server: http.Server;
  port: number;
  eventBus: AlertEventBus;
  readUserId: string;
  noPermUserId: string;
}

interface BuildServerOpts {
  hubEnabled?: boolean;
  heartbeatIntervalMs?: number;
  /** F-C1 (fix wave) — override para inyectar un repo que rechaza. */
  featureFlagRepo?: FeatureFlagRepository;
}

async function buildServer(opts: BuildServerOpts = {}): Promise<Fixture> {
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
  const eventBus = new AlertEventBus();
  const ingestAlert = new IngestAlert(repo, eventBus);
  const listAlerts = new ListAlerts(repo);
  const acknowledgeAlert = new AcknowledgeAlert(repo, eventBus);

  const inMemoryFlagRepo = new InMemoryFeatureFlagRepository();
  inMemoryFlagRepo.seed('noc-alerts-hub-enabled', opts.hubEnabled !== false);
  const flagRepo = opts.featureFlagRepo ?? inMemoryFlagRepo;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/alerts',
    createAlertsRouter({
      ingestAlert,
      listAlerts,
      acknowledgeAlert,
      ingestKeys: {},
      featureFlagRepo: flagRepo,
      eventBus,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      auth: createAuthMiddleware(new EchoAuthProvider()),
      requirePerm,
    }),
  );
  app.use(errorHandler);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  return { server, port, eventBus, readUserId: readUser.id, noPermUserId: noPermUser.id };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function rawGet(port: number, path: string, cookie?: string): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: cookie ? { Cookie: cookie } : {} },
      (res) => resolve({ req, res }),
    );
    req.on('error', reject);
  });
}

function waitForData(res: http.IncomingMessage, predicate: (buf: string) => boolean, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for SSE data, got so far: ${buf}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      if (predicate(buf)) {
        clearTimeout(timer);
        res.off('data', onData);
        resolve(buf);
      }
    };
    res.on('data', onData);
  });
}

describe('GET /api/alerts/stream', () => {
  it('sin cookie de sesión → 401, el stream no se abre', async () => {
    const { server, port } = await buildServer();

    const { req, res } = await rawGet(port, '/api/alerts/stream');

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);

    req.destroy();
    await closeServer(server);
  });

  it('con sesión pero sin monitoring.read → 403, el stream no se abre', async () => {
    const { server, port, noPermUserId } = await buildServer();

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${noPermUserId}`);

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);

    req.destroy();
    await closeServer(server);
  });

  it('con permiso → 200, headers SSE correctos, flusheados de inmediato', async () => {
    const { server, port, readUserId } = await buildServer();

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${readUserId}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.headers['x-accel-buffering']).toBe('no');

    req.destroy();
    await closeServer(server);
  });

  it('un evento publicado al bus mientras el cliente está conectado llega como frame data: con el NocAlertDto', async () => {
    const { server, port, eventBus, readUserId } = await buildServer();

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${readUserId}`);
    expect(res.statusCode).toBe(200);

    const alert = makeAlert({ id: 'alert-42', fingerprint: 'fp-42-should-not-leak' });
    const pending = waitForData(res, (buf) => buf.includes('data: '));
    eventBus.publish({ type: 'firing', alert });
    const buf = await pending;

    const frameLine = buf.split('\n').find((line) => line.startsWith('data: '));
    expect(frameLine).toBeDefined();
    const payload = JSON.parse((frameLine as string).slice('data: '.length)) as {
      type: string;
      alert: Record<string, unknown>;
    };
    expect(payload.type).toBe('firing');
    expect(payload.alert['id']).toBe('alert-42');
    // DTO, never the raw entity — fingerprint is explicitly excluded (nocAlert.ts DTO contract).
    expect(payload.alert).not.toHaveProperty('fingerprint');

    req.destroy();
    await closeServer(server);
  });

  it('otro ACK (evento acked) llega también como frame data: con el NocAlertDto actualizado', async () => {
    const { server, port, eventBus, readUserId } = await buildServer();

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${readUserId}`);
    expect(res.statusCode).toBe(200);

    const acked = makeAlert({ id: 'alert-7', acknowledged: true, ackBy: 'juan.perez', ackAt: '2026-07-24T10:15:00.000Z' });
    const pending = waitForData(res, (buf) => buf.includes('data: '));
    eventBus.publish({ type: 'acked', alert: acked });
    const buf = await pending;

    const frameLine = buf.split('\n').find((line) => line.startsWith('data: '));
    const payload = JSON.parse((frameLine as string).slice('data: '.length)) as {
      type: string;
      alert: { ackBy?: string; ackAt?: string };
    };
    expect(payload.type).toBe('acked');
    expect(payload.alert.ackBy).toBe('juan.perez');
    expect(payload.alert.ackAt).toBe('2026-07-24T10:15:00.000Z');

    req.destroy();
    await closeServer(server);
  });

  it('heartbeat: cliente recibe pings periódicos (comentario, no data:) mientras no hay eventos de alerta', async () => {
    const { server, port, readUserId } = await buildServer({ heartbeatIntervalMs: 30 });

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${readUserId}`);
    expect(res.statusCode).toBe(200);

    const buf = await waitForData(res, (b) => (b.match(/: ping\n\n/g) ?? []).length >= 2, 2000);

    expect((buf.match(/: ping\n\n/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(buf).not.toMatch(/^data: /m);

    req.destroy();
    await closeServer(server);
  });

  it('al cerrar la conexión, el listener del cliente se remueve del bus (no queda suscripto)', async () => {
    const { server, port, eventBus, readUserId } = await buildServer();

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${readUserId}`);
    expect(res.statusCode).toBe(200);
    expect(eventBus.listenerCount()).toBe(1);

    req.destroy();
    // Real (short) wait for the server to observe the socket close and run
    // req.on('close') — not a fake-timer scenario, this is genuine socket teardown.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(eventBus.listenerCount()).toBe(0);

    await closeServer(server);
  });

  // F-C1 (fix wave, MEDIUM) — el handler async de /stream tragaba rejections:
  // sin next/try-catch, un featureFlagRepo.get() que rechaza (DB hipa) dejaba
  // la conexión colgada (unhandledRejection, la respuesta nunca se mandaba).
  it('si featureFlagRepo.get() rechaza (DB hipa), el request termina con 500 — NO queda colgado', async () => {
    const { server, port, readUserId } = await buildServer({ featureFlagRepo: new RejectingFeatureFlagRepository() });

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${readUserId}`);

    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);

    req.destroy();
    await closeServer(server);
  });

  it('hub deshabilitado (noc-alerts-hub-enabled=false) → 503, el stream no se abre', async () => {
    const { server, port, readUserId } = await buildServer({ hubEnabled: false });

    const { req, res } = await rawGet(port, '/api/alerts/stream', `auth_token=${readUserId}`);

    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);

    req.destroy();
    await closeServer(server);
  });
});
