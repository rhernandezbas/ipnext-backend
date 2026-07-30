/**
 * portalAccountsAdmin.routes — customer-portal-api (Fase 3, task 3.4).
 * Route-level coverage of every scenario in
 * openspec/changes/customer-portal-api/specs/portal-accounts-admin/spec.md.
 *
 * Manual try/catch → instanceof error mapping (NOT the shared errorHandler
 * statusMap) — same convention as the sibling self-service router
 * (portal.routes.ts, Fase 2), deliberately chosen here too: this router is
 * built in parallel with the self-service routes by a different agent sharing
 * this worktree, and touching infrastructure/http/middleware/errorHandler.ts's
 * single shared statusMap object would be a needless collision surface.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';

import { createPortalAccountsAdminRouter } from '@infrastructure/http/routes/portalAccountsAdmin.routes';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { CreatePortalAccount } from '@application/use-cases/portal-admin/CreatePortalAccount';
import { RegeneratePortalPassword } from '@application/use-cases/portal-admin/RegeneratePortalPassword';
import { SetPortalAccountStatus } from '@application/use-cases/portal-admin/SetPortalAccountStatus';
import { DeletePortalAccountAdmin } from '@application/use-cases/portal-admin/DeletePortalAccountAdmin';
import { ListPortalAccounts } from '@application/use-cases/portal-admin/ListPortalAccounts';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryClientPortalLookup } from '@infrastructure/adapters/in-memory/InMemoryClientPortalLookup';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';
import { AuthProvider, CookieConfig } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';

import type { RbacRole, RbacPermission } from '@domain/entities/rbac';

const TEST_SECRET = 'test-secret-for-portal-admin-32ch!';

/**
 * Fake staff auth provider (same pattern as iclassTeams.routes.test.ts's
 * FakeAuthProvider) — accepts `auth_token=fake` for every CRUD-logic test that
 * isn't specifically exercising JWT verification. The two auth-focused
 * describe blocks below ("401 con token de portal" / "403 real end-to-end")
 * use the REAL JwtAuthAdapter instead, on purpose.
 */
class FakeAuthProvider implements AuthProvider {
  async login(): Promise<{ user: User; cookieValue: string; cookieOptions: CookieConfig }> {
    return {
      user: { id: 'staff-1', username: 'staff', email: 'staff@test.com' },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 3600, path: '/' },
    };
  }
  logout(): { cookieOptions: CookieConfig } {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    if (token !== 'fake') throw new Error('invalid');
    return { id: 'staff-1', username: 'staff', email: 'staff@test.com' };
  }
}

/** Same pattern as requirePermission.test.ts's SeedableRbacUserRepo. */
class SeedableRbacUserRepo extends InMemoryRbacUserRepository {
  private readonly userRoles = new Map<string, RbacRole[]>();
  private readonly userPermissions = new Map<string, RbacPermission[]>();

  seedRoles(userId: string, roles: RbacRole[]): void {
    this.userRoles.set(userId, roles);
  }

  seedPermissions(userId: string, permissions: RbacPermission[]): void {
    this.userPermissions.set(userId, permissions);
  }

  override async listRolesForUser(userId: string): Promise<RbacRole[]> {
    return this.userRoles.get(userId) ?? [];
  }

  override async listPermissionsForUser(userId: string): Promise<RbacPermission[]> {
    return this.userPermissions.get(userId) ?? [];
  }
}

const ALLOW: RequestHandler = (_req, _res, next) => next();

function buildStack(opts: { requirePortalManage?: RequestHandler } = {}) {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const clients = new InMemoryClientPortalLookup();
  const hasher = new InMemoryPasswordHasher();

  const createPortalAccount = new CreatePortalAccount(accounts, clients, hasher, () => 'FIXED-PASS-WORD');
  const regeneratePortalPassword = new RegeneratePortalPassword(accounts, sessions, hasher, () => 'NEW-FIXED-PASS');
  const setPortalAccountStatus = new SetPortalAccountStatus(accounts, sessions);
  const deletePortalAccountAdmin = new DeletePortalAccountAdmin(accounts, sessions);
  const listPortalAccounts = new ListPortalAccounts(accounts, clients);

  const authProvider = new FakeAuthProvider();
  const requirePortalManage = opts.requirePortalManage ?? ALLOW;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/portal-accounts',
    createPortalAccountsAdminRouter({
      createPortalAccount,
      regeneratePortalPassword,
      setPortalAccountStatus,
      deletePortalAccountAdmin,
      listPortalAccounts,
      authProvider,
      requirePortalManage,
    }),
  );

  return { app, accounts, sessions, clients, hasher };
}

/**
 * Real-JWT stack — used ONLY by the "401 con token de portal" describe block
 * below, which genuinely exercises `JwtAuthAdapter`'s `aud === 'portal'`
 * rejection (design.md §3), not merely "an unrecognized token 401s".
 */
function buildRealAuthStack() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const clients = new InMemoryClientPortalLookup();
  const hasher = new InMemoryPasswordHasher();

  const createPortalAccount = new CreatePortalAccount(accounts, clients, hasher);
  const regeneratePortalPassword = new RegeneratePortalPassword(accounts, sessions, hasher);
  const setPortalAccountStatus = new SetPortalAccountStatus(accounts, sessions);
  const deletePortalAccountAdmin = new DeletePortalAccountAdmin(accounts, sessions);
  const listPortalAccounts = new ListPortalAccounts(accounts, clients);

  const rbacRepo = new InMemoryRbacUserRepository();
  const loginUseCase = new LoginRbacUser(rbacRepo, hasher);
  const authProvider = new JwtAuthAdapter(loginUseCase, TEST_SECRET);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/portal-accounts',
    createPortalAccountsAdminRouter({
      createPortalAccount,
      regeneratePortalPassword,
      setPortalAccountStatus,
      deletePortalAccountAdmin,
      listPortalAccounts,
      authProvider,
      requirePortalManage: ALLOW,
    }),
  );

  return { app };
}

function portalBearerCookie(): string {
  // A portal (aud=portal) token verifies against the SAME secret as the admin
  // JwtAuthAdapter but MUST be rejected on admin routes (design.md §3).
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const token = tokenService.signAccessToken({ accountId: 'acc-1', clientId: 'client-1' });
  return `auth_token=${token}`;
}

describe('portalAccountsAdmin.routes', () => {
  describe('POST /api/admin/portal-accounts', () => {
    it('201 crea la cuenta y devuelve la password en texto plano una vez', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Ronald Hernández', { documento: '17883799' });

      const res = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1' });

      expect(res.status).toBe(201);
      expect(res.body.password).toBe('FIXED-PASS-WORD');
      expect(res.body.status).toBe('active');
      expect(res.body.mustChangePassword).toBe(true);
      expect(res.body.dni).toBe('17883799');
    });

    it('404 si el cliente no existe', async () => {
      const { app } = buildStack();
      const res = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'ghost' });
      expect(res.status).toBe(404);
    });

    it('409 si el dni ya tiene cuenta', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
      clients.seed('client-2', 'Cliente Dos', { documento: '30111222' });
      await request(app).post('/api/admin/portal-accounts').set('Cookie', 'auth_token=fake').send({ clientId: 'client-1' });

      const res = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-2' });
      expect(res.status).toBe(409);
    });

    it('409 si el clientId ya tiene cuenta', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
      await request(app).post('/api/admin/portal-accounts').set('Cookie', 'auth_token=fake').send({ clientId: 'client-1' });

      const res = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1', dni: '11111111' });
      expect(res.status).toBe(409);
    });

    it('422 si no hay documento en el espejo ni override', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Cliente Sin Doc', {});

      const res = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1' });
      expect(res.status).toBe(422);
    });

    it('400 si falta clientId', async () => {
      const { app } = buildStack();
      const res = await request(app).post('/api/admin/portal-accounts').set('Cookie', 'auth_token=fake').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/admin/portal-accounts', () => {
    it('200 lista paginada con nombre del cliente, dni, status, lastLoginAt', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Ronald Hernández', { documento: '17883799' });
      await request(app).post('/api/admin/portal-accounts').set('Cookie', 'auth_token=fake').send({ clientId: 'client-1' });

      const res = await request(app).get('/api/admin/portal-accounts').set('Cookie', 'auth_token=fake');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        clientId: 'client-1',
        clientName: 'Ronald Hernández',
        dni: '17883799',
        status: 'active',
      });
      expect(res.body.total).toBe(1);
    });
  });

  describe('PATCH /api/admin/portal-accounts/:id', () => {
    it('200 deshabilita la cuenta', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
      const created = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1' });

      const res = await request(app)
        .patch(`/api/admin/portal-accounts/${created.body.id}`)
        .set('Cookie', 'auth_token=fake')
        .send({ status: 'disabled' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('disabled');
    });

    it('400 si status no es active|disabled', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
      const created = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1' });

      const res = await request(app)
        .patch(`/api/admin/portal-accounts/${created.body.id}`)
        .set('Cookie', 'auth_token=fake')
        .send({ status: 'bogus' });
      expect(res.status).toBe(400);
    });

    it('404 si la cuenta no existe', async () => {
      const { app } = buildStack();
      const res = await request(app)
        .patch('/api/admin/portal-accounts/ghost')
        .set('Cookie', 'auth_token=fake')
        .send({ status: 'disabled' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/admin/portal-accounts/:id/regenerate-password', () => {
    it('200 regenera la password y la devuelve una vez', async () => {
      const { app, clients } = buildStack();
      clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
      const created = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1' });

      const res = await request(app)
        .post(`/api/admin/portal-accounts/${created.body.id}/regenerate-password`)
        .set('Cookie', 'auth_token=fake');

      expect(res.status).toBe(200);
      expect(res.body.password).toBe('NEW-FIXED-PASS');
      expect(res.body.mustChangePassword).toBe(true);
    });

    it('404 si la cuenta no existe', async () => {
      const { app } = buildStack();
      const res = await request(app)
        .post('/api/admin/portal-accounts/ghost/regenerate-password')
        .set('Cookie', 'auth_token=fake');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/admin/portal-accounts/:id', () => {
    it('204 borra la cuenta', async () => {
      const { app, clients, accounts } = buildStack();
      clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
      const created = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1' });

      const res = await request(app).delete(`/api/admin/portal-accounts/${created.body.id}`).set('Cookie', 'auth_token=fake');
      expect(res.status).toBe(204);
      expect(await accounts.findById(created.body.id)).toBeNull();
    });

    it('404 si la cuenta no existe', async () => {
      const { app } = buildStack();
      const res = await request(app).delete('/api/admin/portal-accounts/ghost').set('Cookie', 'auth_token=fake');
      expect(res.status).toBe(404);
    });
  });

  describe('Guard granular en las dos capas', () => {
    it('403 cuando un admin autenticado sin portal.manage llama a cualquier ruta del CRUD', async () => {
      const DENY: RequestHandler = (_req: Request, res: Response, _next: NextFunction): void => {
        res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
      };
      const { app } = buildStack({ requirePortalManage: DENY });

      const resList = await request(app).get('/api/admin/portal-accounts').set('Cookie', 'auth_token=fake');
      expect(resList.status).toBe(403);

      const resCreate = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', 'auth_token=fake')
        .send({ clientId: 'client-1' });
      expect(resCreate.status).toBe(403);

      const resPatch = await request(app)
        .patch('/api/admin/portal-accounts/some-id')
        .set('Cookie', 'auth_token=fake')
        .send({ status: 'disabled' });
      expect(resPatch.status).toBe(403);

      const resRegen = await request(app)
        .post('/api/admin/portal-accounts/some-id/regenerate-password')
        .set('Cookie', 'auth_token=fake');
      expect(resRegen.status).toBe(403);

      const resDelete = await request(app).delete('/api/admin/portal-accounts/some-id').set('Cookie', 'auth_token=fake');
      expect(resDelete.status).toBe(403);
    });

    it('403 real end-to-end vía requirePermission cuando el rol no tiene portal.manage', async () => {
      // SeedableRbacUserRepo (same class requirePermission.test.ts uses) doubles
      // as BOTH the login repo (inherited create/findByLogin/password compare)
      // and the permission-resolution repo (overridden listRolesForUser/
      // listPermissionsForUser) — a real end-to-end path: login → cookie →
      // authMiddleware → requirePermission(rbacRepo, 'portal', 'manage').
      const rbacRepo = new SeedableRbacUserRepo();
      const hasher = new InMemoryPasswordHasher();
      const user = await rbacRepo.create({
        name: 'Ventas',
        email: 'ventas-e2e@test.com',
        login: 'ventas-e2e',
        passwordHash: await hasher.hash('password123'),
      });
      rbacRepo.seedRoles(user.id, [{ id: 'role-ventas', code: 'ventas', label: 'Ventas', isSystem: true }]);
      rbacRepo.seedPermissions(user.id, [{ id: 'perm-1', moduleCode: 'clients', action: 'read' }]); // NO portal.manage

      const loginUseCase = new LoginRbacUser(rbacRepo, hasher);
      const authProvider = new JwtAuthAdapter(loginUseCase, TEST_SECRET);
      const requirePortalManage = requirePermission(rbacRepo, 'portal', 'manage');

      const app = express();
      app.use(cookieParser());
      app.use(express.json());
      app.use('/auth', (() => {
        const r = express.Router();
        r.post('/login', async (req: Request, res: Response) => {
          const { username, password } = req.body as { username: string; password: string };
          const { cookieValue, cookieOptions } = await authProvider.login({ username, password });
          res.cookie('auth_token', cookieValue, cookieOptions);
          res.status(200).json({ ok: true });
        });
        return r;
      })());
      app.use(
        '/api/admin/portal-accounts',
        createPortalAccountsAdminRouter({
          createPortalAccount: new CreatePortalAccount(
            new InMemoryPortalAccountRepository(),
            new InMemoryClientPortalLookup(),
            new InMemoryPasswordHasher(),
          ),
          regeneratePortalPassword: new RegeneratePortalPassword(
            new InMemoryPortalAccountRepository(),
            new InMemoryPortalSessionRepository(),
            new InMemoryPasswordHasher(),
          ),
          setPortalAccountStatus: new SetPortalAccountStatus(new InMemoryPortalAccountRepository(), new InMemoryPortalSessionRepository()),
          deletePortalAccountAdmin: new DeletePortalAccountAdmin(new InMemoryPortalAccountRepository(), new InMemoryPortalSessionRepository()),
          listPortalAccounts: new ListPortalAccounts(new InMemoryPortalAccountRepository(), new InMemoryClientPortalLookup()),
          authProvider,
          requirePortalManage,
        }),
      );

      const loginRes = await request(app).post('/auth/login').send({ username: 'ventas-e2e', password: 'password123' });
      const cookie = loginRes.headers['set-cookie'] as unknown as string[];

      const res = await request(app).get('/api/admin/portal-accounts').set('Cookie', cookie);
      expect(res.status).toBe(403);
    });
  });

  describe('401 con token de portal (aud=portal) contra las rutas admin', () => {
    it('401 en GET /api/admin/portal-accounts con un token de portal', async () => {
      const { app } = buildRealAuthStack();
      const res = await request(app).get('/api/admin/portal-accounts').set('Cookie', portalBearerCookie());
      expect(res.status).toBe(401);
    });

    it('401 en POST /api/admin/portal-accounts con un token de portal', async () => {
      const { app } = buildRealAuthStack();
      const res = await request(app)
        .post('/api/admin/portal-accounts')
        .set('Cookie', portalBearerCookie())
        .send({ clientId: 'client-1' });
      expect(res.status).toBe(401);
    });

    it('401 sin cookie alguna', async () => {
      const { app } = buildStack();
      const res = await request(app).get('/api/admin/portal-accounts');
      expect(res.status).toBe(401);
    });
  });
});
