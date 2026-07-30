/**
 * customer-portal-api (Fase 2, task 2.6) — route-level coverage of EVERY scenario
 * in openspec/changes/customer-portal-api/specs/portal-auth/spec.md, wired end to
 * end with in-memory adapters (no Prisma, no real DB — repo convention).
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalLoginRateLimiter, createPortalLoginIpRateLimiter, createPortalGeneralRateLimiter } from '@infrastructure/http/middleware/rateLimiters';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { RefreshPortalSession } from '@application/use-cases/portal/RefreshPortalSession';
import { LogoutPortal } from '@application/use-cases/portal/LogoutPortal';
import { ChangePortalPassword } from '@application/use-cases/portal/ChangePortalPassword';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function buildStack() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const refreshPortalSession = new RefreshPortalSession(accounts, sessions, tokenService);
  const logoutPortal = new LogoutPortal(sessions);
  const changePortalPassword = new ChangePortalPassword(accounts, hasher, sessions);

  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const loginRateLimiter = createPortalLoginRateLimiter({ windowMs: 60_000, limit: 3 });
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 100 });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession,
      logoutPortal,
      changePortalPassword,
      portalAuthMiddleware,
      killSwitch,
      loginRateLimiter,
      generalRateLimiter,
    }),
  );

  // Minimal admin stub — enough to test the cross-audience direction (portal
  // token against an admin route) WITHOUT pulling in the entire RBAC stack.
  const rbacRepo = new InMemoryRbacUserRepository();
  const loginUseCase = new LoginRbacUser(rbacRepo, hasher);
  const adminAuthProvider = new JwtAuthAdapter(loginUseCase, TEST_SECRET);
  const adminAuth = createAuthMiddleware(adminAuthProvider);
  app.get('/api/admin/ping', adminAuth, (_req: Request, res: Response) => res.status(200).json({ ok: true }));

  return { app, accounts, sessions, hasher, settingsRepo, tokenService };
}

async function createAccount(accounts: InMemoryPortalAccountRepository, hasher: InMemoryPasswordHasher, dni: string, password: string) {
  return accounts.create({ clientId: `client-${dni}`, dni, passwordHash: await hasher.hash(password) });
}

describe('portal.routes — portal-auth spec scenarios', () => {
  it('Login exitoso: DNI + password correcta → {accessToken, refreshToken, mustChangePassword}, lastLoginAt actualizado', async () => {
    const { app, accounts, hasher } = buildStack();
    const account = await createAccount(accounts, hasher, '30111222', 'Secret123');

    const res = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.mustChangePassword).toBe(true);

    const refreshed = await accounts.findById(account.id);
    expect(refreshed?.lastLoginAt).not.toBeNull();
  });

  it('Password incorrecta: 401 con mensaje genérico, no distingue de "no existe"', async () => {
    const { app, accounts, hasher } = buildStack();
    await createAccount(accounts, hasher, '30111222', 'Secret123');

    const wrongPass = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'WrongOne' });
    const noSuchDni = await request(app).post('/api/portal/auth/login').send({ dni: '30999999', password: 'WrongOne' });

    expect(wrongPass.status).toBe(401);
    expect(noSuchDni.status).toBe(401);
    expect(wrongPass.body.error).toBe(noSuchDni.body.error);
    expect(wrongPass.body.code).toBe(noSuchDni.body.code);
  });

  it('Cuenta deshabilitada: 401 con el MISMO mensaje genérico (no filtra que existe)', async () => {
    const { app, accounts, hasher } = buildStack();
    const account = await createAccount(accounts, hasher, '30111222', 'Secret123');
    await accounts.update(account.id, { status: 'disabled' });

    const disabled = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });
    const badPass = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'wrong' });

    expect(disabled.status).toBe(401);
    expect(disabled.body.error).toBe(badPass.body.error);
    expect(disabled.body.code).toBe(badPass.body.code);
  });

  it('mustChangePassword: primer login con password autogenerada → true, informado en la respuesta', async () => {
    const { app, accounts, hasher } = buildStack();
    await createAccount(accounts, hasher, '30111222', 'Secret123');

    const res = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });
    expect(res.body.mustChangePassword).toBe(true);
  });

  it('Token de portal contra ruta admin: 401, jamás 200', async () => {
    const { app, accounts, hasher } = buildStack();
    await createAccount(accounts, hasher, '30111222', 'Secret123');
    const login = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });

    const res = await request(app).get('/api/admin/ping').set('Cookie', [`auth_token=${login.body.accessToken}`]);
    expect(res.status).toBe(401);
  });

  it('Token admin contra ruta de portal: 401', async () => {
    const { app } = buildStack();
    const staffToken = jwt.sign({ id: 'u1', login: 'staff', email: 's@x.com' }, TEST_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .post('/api/portal/auth/change-password')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ currentPassword: 'x', newPassword: 'NewPass1' });

    expect(res.status).toBe(401);
  });

  it('Refresh reusado: refresh ya rotado se presenta de nuevo → 401 y TODAS las sesiones de la cuenta se revocan', async () => {
    const { app, accounts, hasher, sessions } = buildStack();
    await createAccount(accounts, hasher, '30111222', 'Secret123');
    const login = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });
    const t1: string = login.body.refreshToken;

    const rotated = await request(app).post('/api/portal/auth/refresh').send({ refreshToken: t1 });
    expect(rotated.status).toBe(200);
    const t2: string = rotated.body.refreshToken;

    const reused = await request(app).post('/api/portal/auth/refresh').send({ refreshToken: t1 });
    expect(reused.status).toBe(401);

    // t2 (the legit rotated session) must also be dead — proves "TODAS las sesiones".
    const stillUsable = await request(app).post('/api/portal/auth/refresh').send({ refreshToken: t2 });
    expect(stillUsable.status).toBe(401);

    // L3 (fix wave): el body del 401 es INDISTINGUIBLE entre "reusado" e
    // "inválido/expirado" — un atacante no puede confirmar que un refresh
    // robado FUE válido alguna vez. La distinción vive solo en logs server-side.
    const invalid = await request(app).post('/api/portal/auth/refresh').send({ refreshToken: 'never-existed' });
    expect(invalid.status).toBe(401);
    expect(reused.body).toEqual(invalid.body);
    expect(stillUsable.body).toEqual(invalid.body);
    expect(reused.body.code).toBe('INVALID_PORTAL_REFRESH_TOKEN');
    void sessions;
  });

  it('Logout: revoca la sesión del refresh presentado', async () => {
    const { app, accounts, hasher } = buildStack();
    await createAccount(accounts, hasher, '30111222', 'Secret123');
    const login = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });
    const refreshToken: string = login.body.refreshToken;

    const logout = await request(app).post('/api/portal/auth/logout').send({ refreshToken });
    expect(logout.status).toBe(204);

    const afterLogout = await request(app).post('/api/portal/auth/refresh').send({ refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it('Cambio de password: exige la actual, valida la nueva y limpia mustChangePassword', async () => {
    const { app, accounts, hasher, tokenService } = buildStack();
    const account = await createAccount(accounts, hasher, '30111222', 'Secret123');
    const accessToken = tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });

    const res = await request(app)
      .post('/api/portal/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'Secret123', newPassword: 'BrandNewPass1' });

    expect(res.status).toBe(200);
    const updated = await accounts.findById(account.id);
    expect(updated?.mustChangePassword).toBe(false);
  });

  it('Fuerza bruta sobre un DNI: excede el rate limit dedicado → 429 sin evaluar credenciales', async () => {
    const { app, accounts, hasher } = buildStack();
    await createAccount(accounts, hasher, '30111222', 'Secret123');
    const hit = () => request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'wrong' });

    await hit();
    await hit();
    await hit();
    const over = await hit(); // limiter configured to 3/window in buildStack()
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });

  it('H3b (fix wave): barrido de enumeración — DNIs DISTINTOS desde la misma IP topan con el limiter por-IP del login → 429', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const settingsRepo = new InMemorySettingsRepository();
    const tokenService = new JwtPortalTokenService(TEST_SECRET);

    const app = express();
    app.use(express.json());
    app.use(
      '/api/portal',
      createPortalRouter({
        portalLogin: new PortalLogin(accounts, sessions, hasher, tokenService),
        refreshPortalSession: new RefreshPortalSession(accounts, sessions, tokenService),
        logoutPortal: new LogoutPortal(sessions),
        changePortalPassword: new ChangePortalPassword(accounts, hasher, sessions),
        portalAuthMiddleware: createPortalAuthMiddleware(tokenService, accounts),
        killSwitch: createPortalKillSwitchMiddleware(settingsRepo, 30_000),
        // ip:dni generoso a propósito: lo que corta el barrido es el techo por IP.
        loginRateLimiter: createPortalLoginRateLimiter({ windowMs: 60_000, limit: 100 }),
        loginIpRateLimiter: createPortalLoginIpRateLimiter({ windowMs: 60_000, limit: 2 }),
        generalRateLimiter: createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 100 }),
      }),
    );

    const hit = (dni: string) => request(app).post('/api/portal/auth/login').send({ dni, password: 'x' });
    expect((await hit('10000001')).status).toBe(401);
    expect((await hit('10000002')).status).toBe(401);
    const over = await hit('10000003');
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });

  it('L6 (fix wave): un error inesperado en login → 500 Y el error se LOGUEA (no se traga — un bug de Prisma en prod sería invisible)', async () => {
    const { app: _ignored, accounts, sessions, hasher, settingsRepo, tokenService } = buildStack();
    void _ignored;
    const boom = new Error('prisma exploded');
    const brokenLogin = { execute: jest.fn().mockRejectedValue(boom) } as unknown as PortalLogin;

    const app = express();
    app.use(express.json());
    app.use(
      '/api/portal',
      createPortalRouter({
        portalLogin: brokenLogin,
        refreshPortalSession: new RefreshPortalSession(accounts, sessions, tokenService),
        logoutPortal: new LogoutPortal(sessions),
        changePortalPassword: new ChangePortalPassword(accounts, hasher, sessions),
        portalAuthMiddleware: createPortalAuthMiddleware(tokenService, accounts),
        killSwitch: createPortalKillSwitchMiddleware(settingsRepo, 30_000),
        loginRateLimiter: createPortalLoginRateLimiter({ windowMs: 60_000, limit: 100 }),
        generalRateLimiter: createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 100 }),
      }),
    );

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'x' });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.some((call) => call.includes(boom));
      expect(logged).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('Portal apagado: enabled=false → 503 PORTAL_DISABLED en TODO /api/portal/*, incluido login', async () => {
    const { app, accounts, hasher, settingsRepo } = buildStack();
    await createAccount(accounts, hasher, '30111222', 'Secret123');
    await settingsRepo.updateClientPortalSettings({ enabled: false });

    const res = await request(app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PORTAL_DISABLED');
  });
});
