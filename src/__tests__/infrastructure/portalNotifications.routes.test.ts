/**
 * portal-notification-inbox — route-level coverage sobre la app Express real +
 * repos in-memory (molde `portalPush.routes.test.ts` — sin Prisma/DB real).
 *
 * Cubre los casos obligatorios 3 (paginado + `unread` total), 4 (anti-IDOR de
 * `read`, con revert-probe), 5 (`read-all` no toca otras cuentas) y 7
 * (`unread-count` en 0). Los casos 1/2/6 (buzón del envío) viven en
 * `pushServiceAlert.routes.test.ts`, junto a `SendPushServiceAlert`.
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
import { InMemoryPortalNotificationRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalNotificationRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ListPortalNotifications } from '@application/use-cases/portal/ListPortalNotifications';
import { GetPortalNotificationsUnreadCount } from '@application/use-cases/portal/GetPortalNotificationsUnreadCount';
import { MarkPortalNotificationsRead } from '@application/use-cases/portal/MarkPortalNotificationsRead';
import { MarkAllPortalNotificationsRead } from '@application/use-cases/portal/MarkAllPortalNotificationsRead';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function buildStack() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const notifications = new InMemoryPortalNotificationRepository();

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });

  const listPortalNotifications = new ListPortalNotifications(notifications);
  const getPortalNotificationsUnreadCount = new GetPortalNotificationsUnreadCount(notifications);
  const markPortalNotificationsRead = new MarkPortalNotificationsRead(notifications);
  const markAllPortalNotificationsRead = new MarkAllPortalNotificationsRead(notifications);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession: { execute: async () => { throw new Error('not used'); } } as never,
      logoutPortal: { execute: async () => {} } as never,
      changePortalPassword: { execute: async () => {} } as never,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      listPortalNotifications,
      getPortalNotificationsUnreadCount,
      markPortalNotificationsRead,
      markAllPortalNotificationsRead,
    }),
  );

  return { app, accounts, hasher, notifications };
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
  return { accessToken: res.body.accessToken as string, account };
}

describe('GET /api/portal/notifications', () => {
  it('sin auth -> 401', async () => {
    const { app } = buildStack();
    const res = await request(app).get('/api/portal/notifications');
    expect(res.status).toBe(401);
  });

  it('caso obligatorio 3 — pagina y `unread` cuenta el TOTAL de no-leídas, no la página', async () => {
    const { app, accounts, hasher, notifications } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-1');

    // 5 no-leídas, limit=2 -> la página trae 2, pero `unread` refleja las 5.
    for (let i = 0; i < 5; i++) {
      await notifications.create({ accountId: account.id, channel: 'service', title: `Aviso ${i}`, body: 'body' });
    }

    const res = await request(app)
      .get('/api/portal/notifications')
      .query({ page: 1, limit: 2 })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.unread).toBe(5);
    for (const item of res.body.data) {
      expect(Object.keys(item).sort()).toEqual(['body', 'channel', 'data', 'id', 'readAt', 'sentAt', 'title']);
    }
  });

  it('no devuelve notificaciones de OTRA cuenta (anti-IDOR)', async () => {
    const { app, accounts, hasher, notifications } = buildStack();
    const { accessToken } = await loginAs(app, accounts, hasher, 'client-1');
    const otherAccount = await accounts.create({ clientId: 'client-2', dni: 'dni-2', passwordHash: await hasher.hash('x') });
    await notifications.create({ accountId: otherAccount.id, channel: 'service', title: 'ajena', body: 'x' });

    const res = await request(app).get('/api/portal/notifications').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.unread).toBe(0);
  });
});

describe('GET /api/portal/notifications/unread-count', () => {
  it('sin auth -> 401', async () => {
    const { app } = buildStack();
    const res = await request(app).get('/api/portal/notifications/unread-count');
    expect(res.status).toBe(401);
  });

  it('caso obligatorio 7 — con 0 no-leídas -> {unread: 0} con 200', async () => {
    const { app, accounts, hasher } = buildStack();
    const { accessToken } = await loginAs(app, accounts, hasher, 'client-1');

    const res = await request(app).get('/api/portal/notifications/unread-count').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 0 });
  });

  it('refleja el conteo real tras crear avisos', async () => {
    const { app, accounts, hasher, notifications } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-1');
    await notifications.create({ accountId: account.id, channel: 'service', title: 'a', body: 'b' });
    await notifications.create({ accountId: account.id, channel: 'service', title: 'c', body: 'd' });

    const res = await request(app).get('/api/portal/notifications/unread-count').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 2 });
  });
});

describe('POST /api/portal/notifications/read', () => {
  it('sin auth -> 401', async () => {
    const { app } = buildStack();
    const res = await request(app).post('/api/portal/notifications/read').send({ ids: [] });
    expect(res.status).toBe(401);
  });

  it('body inválido (ids no es array) -> 400', async () => {
    const { app, accounts, hasher } = buildStack();
    const { accessToken } = await loginAs(app, accounts, hasher, 'client-1');

    const res = await request(app)
      .post('/api/portal/notifications/read')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ids: 'not-an-array' });

    expect(res.status).toBe(400);
  });

  it('caso obligatorio 4 — marca SOLO ids propios; un id de OTRA cuenta en el array se ignora en silencio', async () => {
    const { app, accounts, hasher, notifications } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-owner');
    const otherAccount = await accounts.create({ clientId: 'client-attacker', dni: 'dni-attacker', passwordHash: await hasher.hash('x') });

    const own = await notifications.create({ accountId: account.id, channel: 'service', title: 'mine', body: 'b' });
    const foreign = await notifications.create({ accountId: otherAccount.id, channel: 'service', title: 'ajena', body: 'b' });

    const res = await request(app)
      .post('/api/portal/notifications/read')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ids: [own.id, foreign.id] });

    expect(res.status).toBe(204);
    expect(notifications.findById(own.id)?.readAt).not.toBeNull();
    // La fila ajena queda intacta — ni error, ni efecto.
    expect(notifications.findById(foreign.id)?.readAt).toBeNull();
  });

  it('marca varias propias en un solo request', async () => {
    const { app, accounts, hasher, notifications } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-1');
    const n1 = await notifications.create({ accountId: account.id, channel: 'service', title: 'a', body: 'b' });
    const n2 = await notifications.create({ accountId: account.id, channel: 'service', title: 'c', body: 'd' });

    const res = await request(app)
      .post('/api/portal/notifications/read')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ids: [n1.id, n2.id] });

    expect(res.status).toBe(204);
    expect(notifications.findById(n1.id)?.readAt).not.toBeNull();
    expect(notifications.findById(n2.id)?.readAt).not.toBeNull();
  });
});

describe('POST /api/portal/notifications/read-all', () => {
  it('sin auth -> 401', async () => {
    const { app } = buildStack();
    const res = await request(app).post('/api/portal/notifications/read-all');
    expect(res.status).toBe(401);
  });

  it('caso obligatorio 5 — marca TODAS las no-leídas de la cuenta y NINGUNA de otra', async () => {
    const { app, accounts, hasher, notifications } = buildStack();
    const { accessToken, account } = await loginAs(app, accounts, hasher, 'client-owner');
    const otherAccount = await accounts.create({ clientId: 'client-other', dni: 'dni-other', passwordHash: await hasher.hash('x') });

    const n1 = await notifications.create({ accountId: account.id, channel: 'service', title: 'a', body: 'b' });
    const n2 = await notifications.create({ accountId: account.id, channel: 'service', title: 'c', body: 'd' });
    const foreign = await notifications.create({ accountId: otherAccount.id, channel: 'service', title: 'ajena', body: 'b' });

    const res = await request(app).post('/api/portal/notifications/read-all').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(204);
    expect(notifications.findById(n1.id)?.readAt).not.toBeNull();
    expect(notifications.findById(n2.id)?.readAt).not.toBeNull();
    expect(notifications.findById(foreign.id)?.readAt).toBeNull();

    const unreadCountRes = await request(app)
      .get('/api/portal/notifications/unread-count')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(unreadCountRes.body).toEqual({ unread: 0 });
  });
});
