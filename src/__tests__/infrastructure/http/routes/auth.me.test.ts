/**
 * auth.me.test.ts — supertest for GET /api/auth/me new extended shape.
 *
 * Spec: rbac-auth-me-extended
 * Tests S1–S4 (super_admin, regular user with roles, user with no roles, unauthenticated).
 * Uses InMemory repos and injects JWT-signed cookies for auth.
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

const TEST_SECRET = 'test-secret-for-auth-me-32chars!!';

async function buildApp() {
  // Repos
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository(roleRepo);
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Seed roles
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Administrador', isSystem: true });
  const tecnicoRole    = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });

  // Seed permissions
  const schedRead  = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
  const schedWrite = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });

  // Grant permissions to tecnico
  await rolePermRepo.grant(tecnicoRole.id, schedRead.id);
  await rolePermRepo.grant(tecnicoRole.id, schedWrite.id);

  // Seed users
  const superAdminUser = await userRepo.create({
    name: 'Super Admin',
    email: 'superadmin@test.com',
    login: 'superadmin',
    passwordHash: await hasher.hash('password123'),
    status: 'active',
  });
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const tecnicoUser = await userRepo.create({
    name: 'Técnico Uno',
    email: 'tecnico@test.com',
    login: 'tecnico1',
    passwordHash: await hasher.hash('password123'),
    status: 'active',
  });
  await userRoleRepo.assign(tecnicoUser.id, tecnicoRole.id);

  const noRoleUser = await userRepo.create({
    name: 'Sin Roles',
    email: 'norole@test.com',
    login: 'norole',
    passwordHash: await hasher.hash('password123'),
    status: 'active',
  });
  // noRoleUser has no role assignments

  // Wire use cases + adapter
  const loginUseCase = new LoginRbacUser(userRepo, hasher);
  const authAdapter  = new JwtAuthAdapter(loginUseCase, TEST_SECRET);
  const resolveUserPermissions = new ResolveUserPermissions(userRoleRepo, rolePermRepo, permRepo);

  // Build app
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', createAuthRouter(authAdapter, userRepo, userRoleRepo, resolveUserPermissions));

  return { app, superAdminUser, tecnicoUser, noRoleUser };
}

async function loginAndGetCookie(app: express.Application, login: string, password: string): Promise<string[]> {
  const res = await request(app)
    .post('/auth/login')
    .send({ username: login, password });
  return res.headers['set-cookie'] as unknown as string[];
}

describe('GET /auth/me — extended shape', () => {
  // S1: super_admin
  it('S1: authenticated as super_admin → 200 with permissions=["*"], roles with code, user fields, Cache-Control header', async () => {
    const { app, superAdminUser } = await buildApp();
    const cookie = await loginAndGetCookie(app, 'superadmin', 'password123');

    const res = await request(app)
      .get('/auth/me')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);

    // user shape
    expect(res.body.user).toMatchObject({
      id: superAdminUser.id,
      login: 'superadmin',
      email: 'superadmin@test.com',
      name: 'Super Admin',
    });

    // roles shape
    expect(res.body.roles).toHaveLength(1);
    expect(res.body.roles[0]).toMatchObject({ code: 'super_admin', label: 'Super Administrador' });
    expect(res.body.roles[0].id).toBeDefined();

    // permissions sentinel
    expect(res.body.permissions).toEqual(['*']);

    // Cache-Control header
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
  });

  // S2: regular user with roles + permissions
  it('S2: authenticated as tecnico1 → 200 with 2 permissions, 1 role', async () => {
    const { app, tecnicoUser } = await buildApp();
    const cookie = await loginAndGetCookie(app, 'tecnico1', 'password123');

    const res = await request(app)
      .get('/auth/me')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(tecnicoUser.id);
    expect(res.body.roles).toHaveLength(1);
    expect(res.body.roles[0].code).toBe('tecnico');
    expect(res.body.permissions).toHaveLength(2);
    expect(res.body.permissions).toContain('scheduling.read');
    expect(res.body.permissions).toContain('scheduling.write');
  });

  // S3: user with no roles
  it('S3: authenticated user with no roles → 200, roles=[], permissions=[]', async () => {
    const { app } = await buildApp();
    const cookie = await loginAndGetCookie(app, 'norole', 'password123');

    const res = await request(app)
      .get('/auth/me')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([]);
    expect(res.body.permissions).toEqual([]);
  });

  // S4: unauthenticated
  it('S4: no auth cookie → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });
});
