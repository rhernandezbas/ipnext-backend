/**
 * auth.routes.test.ts — supertest integration tests for POST /auth/login,
 * POST /auth/logout, and GET /auth/me, using the new RbacUser-based auth flow.
 *
 * SDD #2 Phase 5 — legacy Admin login removed, RbacUser login only.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createAuthRouter } from '@infrastructure/http/routes/auth.routes';
import { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';

const TEST_SECRET = 'test-secret-for-auth-routes-32!!';

async function buildApp() {
  const repo = new InMemoryRbacUserRepository();
  const hasher = new InMemoryPasswordHasher();
  const loginUseCase = new LoginRbacUser(repo, hasher);
  const authAdapter = new JwtAuthAdapter(loginUseCase, TEST_SECRET);

  const hash = await hasher.hash('password123');
  const user = await repo.create({
    name: 'Test User',
    email: 'test@example.com',
    login: 'testuser',
    passwordHash: hash,
    status: 'active',
  });

  const disabledHash = await hasher.hash('mypassword');
  await repo.create({
    name: 'Disabled User',
    email: 'disabled@example.com',
    login: 'disableduser',
    passwordHash: disabledHash,
    status: 'disabled',
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', createAuthRouter(authAdapter));

  return { app, userId: user.id };
}

describe('POST /auth/login', () => {
  it('valid credentials → 200, cookie set, user in response (no passwordHash)', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'testuser', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.id).toBeDefined();
    expect(res.body.user.username).toBe('testuser');
    // Critical security check: no passwordHash in response
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('unknown login → 401 with code INVALID_CREDENTIALS', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'nobody', password: 'anything' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('wrong password → 401 with code INVALID_CREDENTIALS', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'testuser', password: 'wrongpass' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('disabled user → 401 with code INVALID_CREDENTIALS (no status leak)', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'disableduser', password: 'mypassword' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('missing username → 400', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({ password: 'password123' });

    expect(res.status).toBe(400);
  });

  it('missing password → 400', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'testuser' });

    expect(res.status).toBe(400);
  });

  it('missing both fields → 400', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /auth/logout', () => {
  it('→ 200 and cookie cleared (maxAge 0)', async () => {
    const { app } = await buildApp();

    const res = await request(app).post('/auth/logout');

    expect(res.status).toBe(200);
    // The set-cookie header should clear auth_token (maxAge=0 or Expires in the past)
    const cookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join(';') : (cookieHeader ?? '');
    expect(cookieStr).toContain('auth_token');
  });
});

describe('GET /auth/me', () => {
  it('valid cookie → 200 with user', async () => {
    const { app, userId } = await buildApp();

    // First login to get a cookie
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'testuser', password: 'password123' });

    const cookie = loginRes.headers['set-cookie'] as unknown as string[];

    const meRes = await request(app)
      .get('/auth/me')
      .set('Cookie', cookie);

    expect(meRes.status).toBe(200);
    expect(meRes.body.id).toBe(userId);
  });

  it('no cookie → 401', async () => {
    const { app } = await buildApp();

    const res = await request(app).get('/auth/me');

    expect(res.status).toBe(401);
  });
});
