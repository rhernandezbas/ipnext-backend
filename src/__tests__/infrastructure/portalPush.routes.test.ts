/**
 * portal-push-notifications — route-level coverage sobre la app Express real +
 * repos in-memory (molde `portalPromos.routes.test.ts` — sin Prisma/DB real).
 */
import express from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';
import { InMemoryPortalPushPreferenceRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushPreferenceRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { LogoutPortal } from '@application/use-cases/portal/LogoutPortal';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import { UnregisterPortalPushToken } from '@application/use-cases/portal/UnregisterPortalPushToken';
import { GetPortalPushPreferences } from '@application/use-cases/portal/GetPortalPushPreferences';
import { UpdatePortalPushPreferences } from '@application/use-cases/portal/UpdatePortalPushPreferences';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function buildStack() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const pushTokens = new InMemoryPortalPushTokenRepository();
  const pushPrefs = new InMemoryPortalPushPreferenceRepository();

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const logoutPortal = new LogoutPortal(sessions, pushTokens);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });

  const registerPortalPushToken = new RegisterPortalPushToken(pushTokens);
  const unregisterPortalPushToken = new UnregisterPortalPushToken(pushTokens);
  const getPortalPushPreferences = new GetPortalPushPreferences(pushPrefs);
  const updatePortalPushPreferences = new UpdatePortalPushPreferences(pushPrefs);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession: { execute: async () => { throw new Error('not used'); } } as never,
      logoutPortal,
      changePortalPassword: { execute: async () => {} } as never,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      registerPortalPushToken,
      unregisterPortalPushToken,
      getPortalPushPreferences,
      updatePortalPushPreferences,
    }),
  );

  return { app, accounts, hasher, pushTokens, pushPrefs };
}

async function loginAs(
  app: express.Express,
  accounts: InMemoryPortalAccountRepository,
  hasher: InMemoryPasswordHasher,
  clientId: string,
) {
  const dni = `dni-${clientId}`;
  const account = await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string, account };
}

describe('POST /api/portal/push/register', () => {
  it('sin auth -> 401', async () => {
    const { app } = buildStack();
    const res = await request(app).post('/api/portal/push/register').send({ token: 't1', platform: 'android' });
    expect(res.status).toBe(401);
  });

  it('registra el token bajo la cuenta del token de sesión -> 204', async () => {
    const { app, accounts, hasher, pushTokens } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-1');

    const res = await request(app)
      .post('/api/portal/push/register')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'device-tok-1', platform: 'android', deviceLabel: 'Pixel 7' });

    expect(res.status).toBe(204);
    expect(pushTokens.findByToken('device-tok-1')?.accountId).toBe(account.id);
  });

  it('body inválido (platform fuera de enum) -> 400', async () => {
    const { app, accounts, hasher } = buildStack();
    const { accessToken } = await loginAs(app, accounts, hasher, 'client-1');

    const res = await request(app)
      .post('/api/portal/push/register')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'x', platform: 'windows-phone' });

    expect(res.status).toBe(400);
  });

  it('caso obligatorio 1 (ruta) — el mismo token registrado por OTRA cuenta se reasigna', async () => {
    const { app, accounts, hasher, pushTokens } = buildStack();
    const first = await loginAs(app, accounts, hasher, 'client-old');
    await request(app)
      .post('/api/portal/push/register')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .send({ token: 'shared-tok', platform: 'android' });

    const second = await loginAs(app, accounts, hasher, 'client-new');
    await request(app)
      .post('/api/portal/push/register')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .send({ token: 'shared-tok', platform: 'android' });

    expect(pushTokens.findByToken('shared-tok')?.accountId).toBe(second.account.id);
  });
});

describe('DELETE /api/portal/push/register', () => {
  it('caso obligatorio 2 (ruta) — no borra el token de otra cuenta (204 igual, anti-enumeración)', async () => {
    const { app, accounts, hasher, pushTokens } = buildStack();
    const owner = await loginAs(app, accounts, hasher, 'client-owner');
    await request(app)
      .post('/api/portal/push/register')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ token: 'owner-tok', platform: 'android' });

    const attacker = await loginAs(app, accounts, hasher, 'client-attacker');
    const res = await request(app)
      .delete('/api/portal/push/register')
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .send({ token: 'owner-tok' });

    expect(res.status).toBe(204); // anti-enumeración: mismo status que un borrado real
    expect(pushTokens.findByToken('owner-tok')?.accountId).toBe(owner.account.id);
  });

  it('borra el token propio -> 204', async () => {
    const { app, accounts, hasher, pushTokens } = buildStack();
    const { accessToken } = await loginAs(app, accounts, hasher, 'client-1');
    await request(app)
      .post('/api/portal/push/register')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'my-tok', platform: 'android' });

    const res = await request(app)
      .delete('/api/portal/push/register')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'my-tok' });

    expect(res.status).toBe(204);
    expect(pushTokens.findByToken('my-tok')).toBeUndefined();
  });
});

describe('GET /api/portal/push/preferences', () => {
  it('caso obligatorio 3 (ruta) — crea defaults serviceAlerts=true, promos=false', async () => {
    const { app, accounts, hasher } = buildStack();
    const { accessToken } = await loginAs(app, accounts, hasher, 'client-1');

    const res = await request(app).get('/api/portal/push/preferences').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serviceAlerts: true, promos: false });
  });
});

describe('PUT /api/portal/push/preferences', () => {
  it('caso obligatorio 4 (ruta) — promos false->true estampa el opt-in usando X-App-Version', async () => {
    const { app, accounts, hasher, pushPrefs } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-1');

    const res = await request(app)
      .put('/api/portal/push/preferences')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-App-Version', '1.4.0')
      .send({ promos: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serviceAlerts: true, promos: true });
    const raw = await pushPrefs.getOrCreate(account.id);
    expect(raw.promosOptInAt).not.toBeNull();
    expect(raw.promosOptInAppVersion).toBe('1.4.0');
  });

  it('promos true->false conserva el estampado (histórico) tras apagar de nuevo', async () => {
    const { app, accounts, hasher, pushPrefs } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-1');
    await request(app)
      .put('/api/portal/push/preferences')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-App-Version', '1.4.0')
      .send({ promos: true });

    const res = await request(app)
      .put('/api/portal/push/preferences')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-App-Version', '1.5.0')
      .send({ promos: false });

    expect(res.status).toBe(200);
    expect(res.body.promos).toBe(false);
    const raw = await pushPrefs.getOrCreate(account.id);
    expect(raw.promosOptInAppVersion).toBe('1.4.0'); // NO se pisó con 1.5.0
  });

  it('body con campo desconocido -> 400 (.strict())', async () => {
    const { app, accounts, hasher } = buildStack();
    const { accessToken } = await loginAs(app, accounts, hasher, 'client-1');

    const res = await request(app)
      .put('/api/portal/push/preferences')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ promos: true, notAField: 1 });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/portal/auth/logout — con pushToken', () => {
  it('desregistra el token del dispositivo que cierra sesión en el MISMO viaje', async () => {
    const { app, accounts, hasher, pushTokens } = buildStack();
    const { accessToken, refreshToken } = await loginAs(app, accounts, hasher, 'client-1');
    await request(app)
      .post('/api/portal/push/register')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'device-on-logout', platform: 'android' });

    const res = await request(app).post('/api/portal/auth/logout').send({ refreshToken, pushToken: 'device-on-logout' });

    expect(res.status).toBe(204);
    expect(pushTokens.findByToken('device-on-logout')).toBeUndefined();
  });
});
