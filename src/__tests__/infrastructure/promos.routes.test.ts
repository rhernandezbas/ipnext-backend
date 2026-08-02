/**
 * portal-promos — admin CRUD (`/api/promos`), calco EXACTO del fixture de
 * `news.routes.test.ts` (EchoAuthProvider + RBAC in-memory), 3 usuarios:
 * manage / read-only / sin permiso.
 *
 * Read guard:  promos.read
 * Write guard: promos.manage (incluye `audience-preview`)
 *
 * Incluye el caso 9 obligatorio: `audience-preview` con `withAppCount <
 * segmentCount` sobre un fixture con ≥2 clientes CON cuenta de portal y ≥2
 * SIN — nada de fixtures de un solo elemento por lado.
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
import { InMemoryPortalPromoRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPromoRepository';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createPromosRouter } from '@infrastructure/http/routes/promos.routes';

import { ListPortalPromosAdmin } from '@application/use-cases/promos/ListPortalPromosAdmin';
import { GetPortalPromoAdmin } from '@application/use-cases/promos/GetPortalPromoAdmin';
import { CreatePortalPromo } from '@application/use-cases/promos/CreatePortalPromo';
import { UpdatePortalPromo } from '@application/use-cases/promos/UpdatePortalPromo';
import { PreviewPromoAudience } from '@application/use-cases/promos/PreviewPromoAudience';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { CampaignSegmentSource, CampaignSegmentFilter, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';

/** token IS the userId (echoed, molde news.routes.test.ts). */
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

/** Fake narrow — mismo criterio que las suites de messaging-bulk (sin Prisma real). */
class FakeSegmentSource implements Pick<CampaignSegmentSource, 'listSegmentRecipients'> {
  constructor(private readonly candidates: CampaignRecipientCandidate[]) {}
  async listSegmentRecipients(_segment: CampaignSegmentFilter): Promise<CampaignRecipientCandidate[]> {
    return this.candidates;
  }
}

interface Fixture {
  app: express.Express;
  promoRepo: InMemoryPortalPromoRepository;
  manageUserId: string;
  readOnlyUserId: string;
  noPermUserId: string;
}

async function buildApp(segmentSource: Pick<CampaignSegmentSource, 'listSegmentRecipients'> = new FakeSegmentSource([])): Promise<Fixture & { portalAccounts: InMemoryPortalAccountRepository }> {
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

  const managerRole = await roleRepo.create({ code: 'promos_manager', label: 'Promos Manager', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'promos_reader', label: 'Promos Reader', isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'promos', action: 'manage' });
  const readPerm = await permRepo.seed({ moduleCode: 'promos', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const noPermUser = await mkUser('noperm');

  const promoRepo = new InMemoryPortalPromoRepository();
  const portalAccounts = new InMemoryPortalAccountRepository();

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const listPortalPromosAdmin = new ListPortalPromosAdmin(promoRepo);
  const getPortalPromoAdmin = new GetPortalPromoAdmin(promoRepo);
  const createPortalPromo = new CreatePortalPromo(promoRepo);
  const updatePortalPromo = new UpdatePortalPromo(promoRepo);
  const previewPromoAudience = new PreviewPromoAudience(segmentSource, portalAccounts);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/promos',
    createPromosRouter(
      new EchoAuthProvider(userRepo),
      undefined,
      requirePerm,
      listPortalPromosAdmin,
      getPortalPromoAdmin,
      createPortalPromo,
      updatePortalPromo,
      previewPromoAudience,
    ),
  );
  app.use(errorHandler);

  return { app, promoRepo, portalAccounts, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

function validPromoBody(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    title: 'Fibra 300 Mb',
    summary: 'Upgrade gratis',
    body: 'Detalle largo',
    segment: { statuses: [] },
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('GET /api/promos — auth/RBAC', () => {
  it('sin cookie -> 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/promos');
    expect(res.status).toBe(401);
  });

  it('sin promos.read -> 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/promos'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con promos.read -> 200', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/promos'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /api/promos — create (promos.manage)', () => {
  it('con SOLO promos.read -> 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/promos').send(validPromoBody()), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });

  it('con promos.manage -> 201, estampa el autor de la sesión', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/promos').send(validPromoBody()), fx.manageUserId);
    expect(res.status).toBe(201);
    expect(res.body.authorName).toBe('manager');
    expect(res.body.publishedAt).toBeNull(); // sin publishedAt en el body -> borrador
  });

  it('payload inválido (sin title) -> 400', async () => {
    const fx = await buildApp();
    const body = validPromoBody();
    delete (body as Record<string, unknown>)['title'];
    const res = await asUser(request(fx.app).post('/api/promos').send(body), fx.manageUserId);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/promos/:id + PATCH — 404 sobre id inexistente', () => {
  it('GET /:id inexistente -> 404', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/promos/no-existe'), fx.readOnlyUserId);
    expect(res.status).toBe(404);
  });

  it('PATCH /:id inexistente -> 404', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).patch('/api/promos/no-existe').send({ title: 'x' }), fx.manageUserId);
    expect(res.status).toBe(404);
  });

  it('PATCH publishedAt: null vuelve a borrador; luego publishedAt: <fecha> publica', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/promos').send(validPromoBody({ publishedAt: new Date().toISOString() })), fx.manageUserId);
    expect(created.body.publishedAt).not.toBeNull();

    const unpublished = await asUser(request(fx.app).patch(`/api/promos/${created.body.id}`).send({ publishedAt: null }), fx.manageUserId);
    expect(unpublished.status).toBe(200);
    expect(unpublished.body.publishedAt).toBeNull();
  });
});

describe('POST /api/promos/audience-preview — caso 9 (withAppCount < segmentCount)', () => {
  it('≥2 clientes CON cuenta y ≥2 SIN -> segmentCount cuenta todos, withAppCount solo los que tienen PortalAccount', async () => {
    const candidates: CampaignRecipientCandidate[] = [
      { clientId: 'c1', name: 'Con cuenta 1', phone: null, balanceDue: null, whatsappOptOutAt: null },
      { clientId: 'c2', name: 'Con cuenta 2', phone: null, balanceDue: null, whatsappOptOutAt: null },
      { clientId: 'c3', name: 'Sin cuenta 1', phone: null, balanceDue: null, whatsappOptOutAt: null },
      { clientId: 'c4', name: 'Sin cuenta 2', phone: null, balanceDue: null, whatsappOptOutAt: null },
    ];
    const fx = await buildApp(new FakeSegmentSource(candidates));
    const hasher = new InMemoryPasswordHasher();
    await fx.portalAccounts.create({ clientId: 'c1', dni: 'dni-c1', passwordHash: await hasher.hash('x') });
    await fx.portalAccounts.create({ clientId: 'c2', dni: 'dni-c2', passwordHash: await hasher.hash('x') });
    // c3/c4 NO tienen PortalAccount.

    const res = await asUser(
      request(fx.app).post('/api/promos/audience-preview').send({ segment: { statuses: ['active'] } }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ segmentCount: 4, withAppCount: 2 });
    expect(res.body.withAppCount).toBeLessThan(res.body.segmentCount);
  });

  it('sin promos.manage (solo read) -> 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/promos/audience-preview').send({ segment: {} }), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });
});
