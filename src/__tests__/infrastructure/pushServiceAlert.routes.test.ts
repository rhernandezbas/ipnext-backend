/**
 * portal-push-notifications — `POST /api/notifications/push-service-alert{,/preview}`.
 * Molde `promos.routes.test.ts` (EchoAuthProvider + RBAC in-memory, cookie
 * `auth_token=<userId>`), guard `push.send`.
 *
 * portal-notification-inbox — este archivo TAMBIÉN cubre los casos
 * obligatorios 1/2/6 del buzón (el insert de `PortalNotification` que
 * `SendPushServiceAlert` hace por cuenta), porque nacen del MISMO endpoint.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';
import { InMemoryPortalNotificationRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalNotificationRepository';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createNotificationsRouter } from '@infrastructure/http/routes/notifications.routes';
import { SendPushServiceAlert } from '@application/use-cases/notifications/SendPushServiceAlert';
import { PreviewPushServiceAlert } from '@application/use-cases/notifications/PreviewPushServiceAlert';
import { NoopPushSender } from '@infrastructure/adapters/fcm/NoopPushSender';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { CampaignSegmentSource, CampaignSegmentFilter, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import type { PushSender, PushNotificationPayload, PushSendResult } from '@domain/ports/PushSender';
import type { PortalAccountRepository, PortalAccountClientRef } from '@domain/ports/PortalAccountRepository';
import type { PortalNotificationRepository, CreatePortalNotificationInput } from '@domain/ports/PortalNotificationRepository';
import type { PortalNotification } from '@domain/entities/portalNotification';

/** token IS the userId (echoed, molde promos.routes.test.ts/news.routes.test.ts). */
class EchoAuthProvider implements AuthProvider {
  constructor(private readonly userRepo: RbacUserRepository) {}
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
    const user = await this.userRepo.findById(token);
    if (!user) return { id: token, username: token, email: `${token}@test.com`, role: 'admin' };
    return { id: user.id, username: user.login, email: user.email, role: 'admin' };
  }
}

class FakeSegmentSource implements Pick<CampaignSegmentSource, 'listSegmentRecipients'> {
  constructor(private readonly byNode: Record<string, CampaignRecipientCandidate[]> = {}) {}
  async listSegmentRecipients(segment: CampaignSegmentFilter): Promise<CampaignRecipientCandidate[]> {
    if (!segment.networkSiteId) return [];
    return this.byNode[segment.networkSiteId] ?? [];
  }
}

function candidate(clientId: string): CampaignRecipientCandidate {
  return { clientId, name: clientId, phone: null, balanceDue: null, whatsappOptOutAt: null };
}

class FakePushSender implements PushSender {
  public sentTo: string[][] = [];
  readonly dryRun = false;
  async send(tokens: string[], _n: PushNotificationPayload): Promise<PushSendResult> {
    this.sentTo.push(tokens);
    return { invalidTokens: [] };
  }
}

/**
 * FakeAccountDirectory — universo del BUZÓN, SIN concepto de `serviceAlerts`
 * (portal-notification-inbox, timbre vs registro — ver `SendPushServiceAlert`).
 * `addRow` es el test seam para poblarlo desde el fixture.
 */
class FakeAccountDirectory implements Pick<PortalAccountRepository, 'listByClientIds'> {
  private readonly rows: PortalAccountClientRef[] = [];
  addRow(row: PortalAccountClientRef): void {
    this.rows.push(row);
  }
  async listByClientIds(clientIds?: string[]): Promise<PortalAccountClientRef[]> {
    if (clientIds && clientIds.length === 0) return [];
    const set = clientIds ? new Set(clientIds) : null;
    return this.rows.filter((r) => !set || set.has(r.clientId));
  }
}

/** Fake que SIEMPRE tira — caso obligatorio 6 (el insert del buzón nunca tumba el envío). */
class FailingNotificationRepository implements Pick<PortalNotificationRepository, 'create'> {
  public attempts = 0;
  async create(_input: CreatePortalNotificationInput): Promise<PortalNotification> {
    this.attempts++;
    throw new Error('boom — DB caída');
  }
}

const noopStub = { execute: async () => { throw new Error('not used'); } } as never;

async function buildApp(
  opts: {
    sender?: PushSender;
    byNode?: Record<string, CampaignRecipientCandidate[]>;
    notifications?: Pick<PortalNotificationRepository, 'create'>;
  } = {},
) {
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

  const senderRole = await roleRepo.create({ code: 'push_sender', label: 'Push Sender', isSystem: false });
  const noPermRole = await roleRepo.create({ code: 'push_noperm', label: 'No Perm', isSystem: false });
  const sendPerm = await permRepo.seed({ moduleCode: 'push', action: 'send' });
  await rolePermRepo.grant(senderRole.id, sendPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) => userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });
  const senderUser = await mkUser('sender');
  await userRoleRepo.assign(senderUser.id, senderRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, noPermRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const tokens = new InMemoryPortalPushTokenRepository();
  const segments = new FakeSegmentSource(opts.byNode);
  const sender = opts.sender ?? new FakePushSender();
  const notifications = opts.notifications ?? new InMemoryPortalNotificationRepository();
  const accounts = new FakeAccountDirectory();
  const sendPushServiceAlert = new SendPushServiceAlert(tokens, sender, segments, notifications, accounts);
  const previewPushServiceAlert = new PreviewPushServiceAlert(tokens, segments);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/notifications',
    createNotificationsRouter(
      noopStub,
      noopStub,
      noopStub,
      noopStub,
      new EchoAuthProvider(userRepo),
      undefined,
      requirePerm,
      sendPushServiceAlert,
      previewPushServiceAlert,
    ),
  );
  app.use(errorHandler);

  return { app, tokens, notifications, accounts, senderUserId: senderUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('POST /api/notifications/push-service-alert — auth/RBAC', () => {
  it('sin cookie -> 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/notifications/push-service-alert').send({ title: 't', body: 'b' });
    expect(res.status).toBe(401);
  });

  it('caso obligatorio 8 — sin permiso push.send -> 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(
      request(app).post('/api/notifications/push-service-alert').send({ title: 't', body: 'b' }),
      noPermUserId,
    );
    expect(res.status).toBe(403);
  });

  it('body sin title/body -> 400', async () => {
    const { app, senderUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/notifications/push-service-alert').send({}), senderUserId);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/notifications/push-service-alert — envío', () => {
  function seedTargets(tokens: InMemoryPortalPushTokenRepository, accounts: FakeAccountDirectory) {
    const register = new RegisterPortalPushToken(tokens);
    return (async () => {
      tokens.seedAccount('account-a1', 'client-a1', true);
      accounts.addRow({ accountId: 'account-a1', clientId: 'client-a1' });
      await register.execute('account-a1', { token: 'tok-a1', platform: 'android' });
      tokens.seedAccount('account-a2', 'client-a2', true);
      accounts.addRow({ accountId: 'account-a2', clientId: 'client-a2' });
      await register.execute('account-a2', { token: 'tok-a2', platform: 'android' });
      tokens.seedAccount('account-off', 'client-off', false);
      accounts.addRow({ accountId: 'account-off', clientId: 'client-off' });
      await register.execute('account-off', { token: 'tok-off', platform: 'android' });
    })();
  }

  it('caso obligatorio 5 — sin nodo: manda a los opt-in con token vivo (conteos reales)', async () => {
    const { app, tokens, accounts, senderUserId } = await buildApp();
    await seedTargets(tokens, accounts);

    const res = await asUser(
      request(app).post('/api/notifications/push-service-alert').send({ title: 'Corte', body: 'Volvemos a las 15' }),
      senderUserId,
    );

    expect(res.status).toBe(200);
    // inboxed: 3 — TODAS las cuentas seedeadas (a1, a2, y off pese a serviceAlerts=false: el
    // buzón es registro, no timbre — ver el docblock de SendPushServiceAlert).
    expect(res.body).toEqual({ recipients: 2, devices: 2, invalidated: 0, dryRun: false, inboxed: 3 });
  });

  it('caso obligatorio 6 — con nodo: solo los clientes de ese nodo', async () => {
    const { app, tokens, accounts, senderUserId } = await buildApp({
      byNode: { 'node-a': [candidate('client-a1')] },
    });
    await seedTargets(tokens, accounts);

    const res = await asUser(
      request(app)
        .post('/api/notifications/push-service-alert')
        .send({ title: 'Falla en tu zona', body: 'Trabajando', networkSiteId: 'node-a' }),
      senderUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(1);
    expect(res.body.devices).toBe(1);
    expect(res.body.inboxed).toBe(1); // solo account-a1 matchea el nodo
  });

  it('caso obligatorio 9 — sin FIREBASE_SERVICE_ACCOUNT_JSON (NoopPushSender): 200 con dryRun=true, nada explota', async () => {
    const { app, tokens, accounts, senderUserId } = await buildApp({ sender: new NoopPushSender() });
    await seedTargets(tokens, accounts);

    const res = await asUser(
      request(app).post('/api/notifications/push-service-alert').send({ title: 'Aviso', body: 'body' }),
      senderUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.invalidated).toBe(0); // Noop nunca invalida (no hay respuesta real que clasificar)
    expect(res.body.inboxed).toBe(3); // el buzón se escribe IGUAL, incluso en dry-run del push
  });
});

describe('POST /api/notifications/push-service-alert — buzón (portal-notification-inbox)', () => {
  it('caso obligatorio 1 — crea fila para TODA cuenta del filtro: con token, SIN token, y con serviceAlerts=false', async () => {
    const notifications = new InMemoryPortalNotificationRepository();
    const { app, tokens, accounts, senderUserId } = await buildApp({ notifications });
    const register = new RegisterPortalPushToken(tokens);

    tokens.seedAccount('account-a1', 'client-a1', true);
    accounts.addRow({ accountId: 'account-a1', clientId: 'client-a1' });
    await register.execute('account-a1', { token: 'tok-a1', platform: 'android' });

    tokens.seedAccount('account-a2', 'client-a2', true);
    accounts.addRow({ accountId: 'account-a2', clientId: 'client-a2' });
    await register.execute('account-a2', { token: 'tok-a2', platform: 'android' });

    // serviceAlerts=false — NO recibe push, pero SÍ fila de buzón.
    tokens.seedAccount('account-off', 'client-off', false);
    accounts.addRow({ accountId: 'account-off', clientId: 'client-off' });
    await register.execute('account-off', { token: 'tok-off', platform: 'android' });

    // SIN token registrado nunca — solo existe en el directorio de cuentas.
    accounts.addRow({ accountId: 'account-no-token', clientId: 'client-no-token' });

    const res = await asUser(
      request(app).post('/api/notifications/push-service-alert').send({ title: 'Corte', body: 'Volvemos a las 15' }),
      senderUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(2); // solo a1/a2 tienen token vivo + serviceAlerts=true
    expect(res.body.inboxed).toBe(4); // TODAS las cuentas del filtro, sin excepción

    for (const accountId of ['account-a1', 'account-a2', 'account-off', 'account-no-token']) {
      const page = await notifications.listForAccount(accountId, {});
      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.readAt).toBeNull();
    }
  });

  it('caso obligatorio 2 — el filtro por nodo también aplica al buzón: cuenta de OTRO nodo -> sin fila', async () => {
    const notifications = new InMemoryPortalNotificationRepository();
    const { app, tokens, accounts, senderUserId } = await buildApp({
      byNode: { 'node-x': [candidate('client-in')] },
      notifications,
    });
    const register = new RegisterPortalPushToken(tokens);

    tokens.seedAccount('account-in', 'client-in', true);
    accounts.addRow({ accountId: 'account-in', clientId: 'client-in' });
    await register.execute('account-in', { token: 'tok-in', platform: 'android' });

    // Cuenta de OTRO nodo — no matchea el segmento de 'node-x'.
    accounts.addRow({ accountId: 'account-other', clientId: 'client-other' });

    const res = await asUser(
      request(app)
        .post('/api/notifications/push-service-alert')
        .send({ title: 'Falla en tu zona', body: 'Trabajando', networkSiteId: 'node-x' }),
      senderUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.inboxed).toBe(1);

    const inNode = await notifications.listForAccount('account-in', {});
    expect(inNode.data).toHaveLength(1);
    const outsideNode = await notifications.listForAccount('account-other', {});
    expect(outsideNode.data).toHaveLength(0);
  });

  it('caso obligatorio 6 — falla el insert del buzón (repo que tira): el push IGUAL sale y la respuesta lo refleja', async () => {
    const failingNotifications = new FailingNotificationRepository();
    const { app, tokens, accounts, senderUserId } = await buildApp({ notifications: failingNotifications });
    await (async () => {
      const register = new RegisterPortalPushToken(tokens);
      tokens.seedAccount('account-a1', 'client-a1', true);
      accounts.addRow({ accountId: 'account-a1', clientId: 'client-a1' });
      await register.execute('account-a1', { token: 'tok-a1', platform: 'android' });
    })();

    const res = await asUser(
      request(app).post('/api/notifications/push-service-alert').send({ title: 'Corte', body: 'Volvemos a las 15' }),
      senderUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(1); // el push salió igual
    expect(res.body.devices).toBe(1);
    expect(res.body.inboxed).toBe(0); // nada se persistió, pero no explotó
    expect(failingNotifications.attempts).toBe(1);
  });
});

describe('POST /api/notifications/push-service-alert/preview', () => {
  it('mismos filtros, solo conteos, sin mandar', async () => {
    const { app, tokens, senderUserId } = await buildApp();
    const register = new RegisterPortalPushToken(tokens);
    tokens.seedAccount('account-a1', 'client-a1', true);
    await register.execute('account-a1', { token: 'tok-a1', platform: 'android' });

    const res = await asUser(request(app).post('/api/notifications/push-service-alert/preview').send({}), senderUserId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recipients: 1, devices: 1 });
  });

  it('sin permiso push.send -> 403 (mismo guard que el envío real)', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/notifications/push-service-alert/preview').send({}), noPermUserId);
    expect(res.status).toBe(403);
  });
});
