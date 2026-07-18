/**
 * N1 (noc-broadcast) — /api/messaging/noc-broadcast router (supertest, in-memory).
 * Molde gestionRealIngest.routes.test + canned-responses perms object.
 *  - GET  /config  → masked config (apiKey NEVER serialized in full), gate messaging:read
 *  - PUT  /config  → Zod partial, URL validation, apiKey preserved when empty/absent, gate messaging:manage
 *  - POST /test    → sends the fixed test message via the gateway, gate messaging:manage
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createNocBroadcastRouter } from '@infrastructure/http/routes/nocBroadcast.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { GetNocBroadcastConfig } from '@application/use-cases/nocBroadcast/GetNocBroadcastConfig';
import { UpdateNocBroadcastConfig } from '@application/use-cases/nocBroadcast/UpdateNocBroadcastConfig';
import { SendNocBroadcastTest } from '@application/use-cases/nocBroadcast/SendNocBroadcastTest';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { NocBroadcastNotConfiguredError, EvolutionApiError } from '@domain/errors/nocBroadcast';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { AuthenticationError } from '@domain/errors';

const AUTH_COOKIE = 'auth_token=fake';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

const grant: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req: Request, res: Response, _next: NextFunction) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

function buildApp(opts?: { read?: RequestHandler; manage?: RequestHandler }) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const configRepo = new InMemoryNocBroadcastConfigRepository();
  const gateway = new FakeGateway();

  app.use(
    '/api/messaging/noc-broadcast',
    createNocBroadcastRouter(
      new FakeAuthProvider(),
      { read: opts?.read ?? grant, manage: opts?.manage ?? grant },
      new GetNocBroadcastConfig(configRepo),
      new UpdateNocBroadcastConfig(configRepo),
      new SendNocBroadcastTest(gateway),
    ),
  );
  app.use(errorHandler);
  return { app, configRepo, gateway };
}

describe('nocBroadcast.routes — GET /config (masking)', () => {
  it('default config → 200 with masked shape (no raw apiKey, hasApiKey false)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/noc-broadcast/config').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      evolutionBaseUrl: '',
      evolutionInstance: '',
      targetChat: '',
      appPublicUrl: '',
      hasApiKey: false,
      apiKeyLast4: null,
      configured: false,
    });
    expect(res.body).not.toHaveProperty('evolutionApiKey');
  });

  it('with a stored key → masks it (last 4 only), never the full key', async () => {
    const { app, configRepo } = buildApp();
    await configRepo.update({
      enabled: true,
      evolutionBaseUrl: 'http://pi.local:8080',
      evolutionApiKey: 'super-secret-9Z7K',
      evolutionInstance: 'ronald noc',
      targetChat: '123@g.us',
      appPublicUrl: 'http://190.7.234.37:7778',
    });
    const res = await request(app).get('/api/messaging/noc-broadcast/config').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.hasApiKey).toBe(true);
    expect(res.body.apiKeyLast4).toBe('9Z7K');
    expect(res.body.configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-9Z7K');
  });

  it('without auth cookie → 401', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/noc-broadcast/config');
    expect(res.status).toBe(401);
  });

  it('GET denied by messaging:read gate → 403', async () => {
    const { app } = buildApp({ read: deny });
    const res = await request(app).get('/api/messaging/noc-broadcast/config').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(403);
  });
});

describe('nocBroadcast.routes — PUT /config', () => {
  it('valid body updates and returns the masked DTO', async () => {
    const { app, configRepo } = buildApp();
    const res = await request(app)
      .put('/api/messaging/noc-broadcast/config')
      .set('Cookie', AUTH_COOKIE)
      .send({
        enabled: true,
        evolutionBaseUrl: 'http://pi.local:8080',
        evolutionApiKey: 'key-1234',
        evolutionInstance: 'ronald noc',
        targetChat: '123@g.us',
        appPublicUrl: 'http://190.7.234.37:7778',
      });
    expect(res.status).toBe(200);
    expect(res.body.hasApiKey).toBe(true);
    expect(res.body.apiKeyLast4).toBe('1234');
    expect((await configRepo.get()).evolutionApiKey).toBe('key-1234');
  });

  it('preserves the existing apiKey when the body omits it', async () => {
    const { app, configRepo } = buildApp();
    await configRepo.update({ evolutionApiKey: 'stored-key-5678' });
    const res = await request(app)
      .put('/api/messaging/noc-broadcast/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ targetChat: 'new@g.us', enabled: true });
    expect(res.status).toBe(200);
    expect((await configRepo.get()).evolutionApiKey).toBe('stored-key-5678');
    expect((await configRepo.get()).targetChat).toBe('new@g.us');
  });

  it('preserves the existing apiKey when the body sends an EMPTY apiKey', async () => {
    const { app, configRepo } = buildApp();
    await configRepo.update({ evolutionApiKey: 'stored-key-5678' });
    const res = await request(app)
      .put('/api/messaging/noc-broadcast/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ evolutionApiKey: '', evolutionInstance: 'ronald noc' });
    expect(res.status).toBe(200);
    expect((await configRepo.get()).evolutionApiKey).toBe('stored-key-5678');
    expect((await configRepo.get()).evolutionInstance).toBe('ronald noc');
  });

  it('rejects an invalid evolutionBaseUrl → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/messaging/noc-broadcast/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ evolutionBaseUrl: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid appPublicUrl → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/messaging/noc-broadcast/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ appPublicUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT denied by messaging:manage gate → 403', async () => {
    const { app } = buildApp({ manage: deny });
    const res = await request(app)
      .put('/api/messaging/noc-broadcast/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });
});

describe('nocBroadcast.routes — POST /test', () => {
  it('sends the fixed test message via the gateway → 200 { ok: true }', async () => {
    const { app, gateway } = buildApp();
    const res = await request(app).post('/api/messaging/noc-broadcast/test').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]).toContain('Prueba de Difusión NOC');
  });

  it('gateway not configured → 503 NOC_BROADCAST_NOT_CONFIGURED', async () => {
    const { app, gateway } = buildApp();
    gateway.error = new NocBroadcastNotConfiguredError();
    const res = await request(app).post('/api/messaging/noc-broadcast/test').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOC_BROADCAST_NOT_CONFIGURED');
  });

  it('Evolution API failure → 502 EVOLUTION_API_ERROR', async () => {
    const { app, gateway } = buildApp();
    gateway.error = new EvolutionApiError('connect ECONNREFUSED');
    const res = await request(app).post('/api/messaging/noc-broadcast/test').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('EVOLUTION_API_ERROR');
  });

  it('POST /test denied by messaging:manage gate → 403', async () => {
    const { app } = buildApp({ manage: deny });
    const res = await request(app).post('/api/messaging/noc-broadcast/test').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(403);
  });
});
