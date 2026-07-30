/**
 * portal.manage — exposure via GET /auth/me (customer-portal-api, Fase 3, task 3.3).
 *
 * portal-accounts-admin spec "Guard granular en las dos capas": the permission
 * must be added to the backend RBAC catalog AND exposed via /me so the FE can
 * read it (WORKFLOW's "regla de las dos capas"). This test proves the SECOND
 * layer end to end: a role granted (portal, manage) resolves to the string
 * "portal.manage" in the real `/auth/me` response body — same wiring
 * (`ResolveUserPermissions` → `auth.routes.ts`) as every other module, no new
 * code needed on that path (the module/action pair already existed in the TS
 * catalog before this change — see the migration test's discovery note).
 * Mirrors `auth.me.test.ts` S2 exactly, scoped to 'portal'.'manage'.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createAuthRouter } from '@infrastructure/http/routes/auth.routes';
import { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';
import { ResolveUserPermissions } from '@application/use-cases/rbac/ResolveUserPermissions';

const TEST_SECRET = 'test-secret-for-portal-manage-32ch';

async function buildApp() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository(roleRepo);
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  const administradorRole = await roleRepo.create({ code: 'administrador', label: 'Administrador', isSystem: true });
  const ventasRole = await roleRepo.create({ code: 'ventas', label: 'Ventas', isSystem: true });

  const portalManage = await permRepo.seed({ moduleCode: 'portal', action: 'manage' });
  await rolePermRepo.grant(administradorRole.id, portalManage.id);

  const adminUser = await userRepo.create({
    name: 'Admin Portal',
    email: 'admin-portal@test.com',
    login: 'admin-portal',
    passwordHash: await hasher.hash('password123'),
    status: 'active',
  });
  await userRoleRepo.assign(adminUser.id, administradorRole.id);

  const ventasUser = await userRepo.create({
    name: 'Ventas Uno',
    email: 'ventas-portal@test.com',
    login: 'ventas-portal',
    passwordHash: await hasher.hash('password123'),
    status: 'active',
  });
  await userRoleRepo.assign(ventasUser.id, ventasRole.id);

  const loginUseCase = new LoginRbacUser(userRepo, hasher);
  const authAdapter = new JwtAuthAdapter(loginUseCase, TEST_SECRET);
  const resolveUserPermissions = new ResolveUserPermissions(userRoleRepo, rolePermRepo, permRepo);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', createAuthRouter(authAdapter, userRepo, userRoleRepo, resolveUserPermissions));

  return { app };
}

async function loginAndGetCookie(app: express.Application, login: string, password: string): Promise<string[]> {
  const res = await request(app).post('/auth/login').send({ username: login, password });
  return res.headers['set-cookie'] as unknown as string[];
}

describe('portal.manage — exposure via GET /auth/me', () => {
  it('a role granted (portal, manage) exposes "portal.manage" in /auth/me permissions', async () => {
    const { app } = await buildApp();
    const cookie = await loginAndGetCookie(app, 'admin-portal', 'password123');

    const res = await request(app).get('/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.permissions).toContain('portal.manage');
  });

  it('a role NOT granted (portal, manage) does not see it in /auth/me permissions', async () => {
    const { app } = await buildApp();
    const cookie = await loginAndGetCookie(app, 'ventas-portal', 'password123');

    const res = await request(app).get('/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.permissions).not.toContain('portal.manage');
  });
});
