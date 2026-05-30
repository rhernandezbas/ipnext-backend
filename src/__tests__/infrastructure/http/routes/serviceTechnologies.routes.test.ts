/**
 * serviceTechnologies.routes.test.ts — supertest for /api/service-technologies CRUD.
 * Uses FakeAuthProvider (auth-only, no RBAC permission check on these routes).
 * Covers ST-1…ST-5: list, get, create, update, delete; 200/201/204/400/401/404/409.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createServiceTechnologiesRouter } from '@infrastructure/http/routes/serviceTechnologies.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryServiceTechnologyRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceTechnologyRepository';

import { ListServiceTechnology } from '@application/use-cases/ListServiceTechnology';
import { GetServiceTechnology } from '@application/use-cases/GetServiceTechnology';
import { CreateServiceTechnology } from '@application/use-cases/CreateServiceTechnology';
import { UpdateServiceTechnology } from '@application/use-cases/UpdateServiceTechnology';
import { DeleteServiceTechnology } from '@application/use-cases/DeleteServiceTechnology';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { AuthenticationError } from '@domain/errors';

const AUTH_COOKIE = 'auth_token=fake-token';

class FakeAuthProvider implements AuthProvider {
  constructor(private readonly fail: boolean = false) {}
  async login() {
    return {
      user: { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake-token',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    if (this.fail) throw new AuthenticationError('Invalid token');
    return { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

interface Harness {
  app: express.Express;
  repo: InMemoryServiceTechnologyRepository;
}

function buildApp(authFail = false): Harness {
  const repo = new InMemoryServiceTechnologyRepository();
  const authProvider = new FakeAuthProvider(authFail);

  const list   = new ListServiceTechnology(repo);
  const get    = new GetServiceTechnology(repo);
  const create = new CreateServiceTechnology(repo);
  const update = new UpdateServiceTechnology(repo);
  const del    = new DeleteServiceTechnology(repo);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createServiceTechnologiesRouter(authProvider, list, get, create, update, del));
  app.use(errorHandler);

  return { app, repo };
}

// ─── ST-1: List ──────────────────────────────────────────────────────────────

describe('GET /api/service-technologies', () => {
  it('ST-1.1 returns 200 with empty array when no technologies exist', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/service-technologies').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('ST-1.2 returns 200 with list of technologies', async () => {
    const { app, repo } = buildApp();
    await repo.create({ name: 'Fiber', description: null });
    await repo.create({ name: 'DOCSIS', description: 'Cable HFC' });
    const res = await request(app).get('/api/service-technologies').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('ST-1.3 returns 401 when unauthenticated', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/service-technologies');
    expect(res.status).toBe(401);
  });
});

// ─── ST-2: Get by ID ─────────────────────────────────────────────────────────

describe('GET /api/service-technologies/:id', () => {
  it('ST-2.1 returns 200 with the technology', async () => {
    const { app, repo } = buildApp();
    const item = await repo.create({ name: 'FTTH', description: null });
    const res = await request(app)
      .get(`/api/service-technologies/${item.id}`)
      .set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('FTTH');
    expect(res.body.id).toBe(item.id);
  });

  it('ST-2.2 returns 404 with SERVICE_TECHNOLOGY_NOT_FOUND for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/service-technologies/unknown-id')
      .set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_TECHNOLOGY_NOT_FOUND');
  });

  it('ST-2.3 returns 401 when unauthenticated', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/service-technologies/some-id');
    expect(res.status).toBe(401);
  });
});

// ─── ST-3: Create ────────────────────────────────────────────────────────────

describe('POST /api/service-technologies', () => {
  it('ST-3.1 returns 201 with created technology', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/service-technologies')
      .set('Cookie', AUTH_COOKIE)
      .send({ name: 'Wireless', description: 'Enlace inalámbrico' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Wireless');
    expect(res.body.description).toBe('Enlace inalámbrico');
    expect(res.body.id).toBeTruthy();
  });

  it('ST-3.2 returns 409 with SERVICE_TECHNOLOGY_NAME_CONFLICT on duplicate name', async () => {
    const { app, repo } = buildApp();
    await repo.create({ name: 'Fiber', description: null });
    const res = await request(app)
      .post('/api/service-technologies')
      .set('Cookie', AUTH_COOKIE)
      .send({ name: 'fiber' }); // case-insensitive
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVICE_TECHNOLOGY_NAME_CONFLICT');
  });

  it('ST-3.3 returns 400 on missing required field name', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/service-technologies')
      .set('Cookie', AUTH_COOKIE)
      .send({ description: 'no name' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('ST-3.4 returns 401 when unauthenticated', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/service-technologies')
      .send({ name: 'HFC' });
    expect(res.status).toBe(401);
  });
});

// ─── ST-4: Update ────────────────────────────────────────────────────────────

describe('PUT /api/service-technologies/:id', () => {
  it('ST-4.1 returns 200 with updated technology', async () => {
    const { app, repo } = buildApp();
    const item = await repo.create({ name: 'Radio', description: null });
    const res = await request(app)
      .put(`/api/service-technologies/${item.id}`)
      .set('Cookie', AUTH_COOKIE)
      .send({ name: 'Radio 5GHz', description: 'Radioenlace 5GHz' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Radio 5GHz');
    expect(res.body.description).toBe('Radioenlace 5GHz');
  });

  it('ST-4.2 returns 404 for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/service-technologies/ghost')
      .set('Cookie', AUTH_COOKIE)
      .send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_TECHNOLOGY_NOT_FOUND');
  });

  it('ST-4.3 returns 409 on name collision', async () => {
    const { app, repo } = buildApp();
    await repo.create({ name: 'Fiber', description: null });
    const b = await repo.create({ name: 'DOCSIS', description: null });
    const res = await request(app)
      .put(`/api/service-technologies/${b.id}`)
      .set('Cookie', AUTH_COOKIE)
      .send({ name: 'Fiber' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVICE_TECHNOLOGY_NAME_CONFLICT');
  });

  it('ST-4.4 returns 401 when unauthenticated', async () => {
    const { app, repo } = buildApp();
    const item = await repo.create({ name: 'Fiber', description: null });
    const res = await request(app)
      .put(`/api/service-technologies/${item.id}`)
      .send({ name: 'Fiber2' });
    expect(res.status).toBe(401);
  });
});

// ─── ST-5: Delete ────────────────────────────────────────────────────────────

describe('DELETE /api/service-technologies/:id', () => {
  it('ST-5.1 returns 204 on successful delete', async () => {
    const { app, repo } = buildApp();
    const item = await repo.create({ name: 'HFC', description: null });
    const res = await request(app)
      .delete(`/api/service-technologies/${item.id}`)
      .set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(204);
  });

  it('ST-5.2 returns 404 for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .delete('/api/service-technologies/ghost')
      .set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_TECHNOLOGY_NOT_FOUND');
  });

  it('ST-5.3 returns 409 with SERVICE_TECHNOLOGY_IN_USE when services use it', async () => {
    const { app, repo } = buildApp();
    const item = await repo.create({ name: 'Fiber', description: null });
    repo.serviceCounts['Fiber'] = 3;
    const res = await request(app)
      .delete(`/api/service-technologies/${item.id}`)
      .set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVICE_TECHNOLOGY_IN_USE');
  });

  it('ST-5.4 returns 401 when unauthenticated', async () => {
    const { app, repo } = buildApp();
    const item = await repo.create({ name: 'Fiber', description: null });
    const res = await request(app)
      .delete(`/api/service-technologies/${item.id}`);
    expect(res.status).toBe(401);
  });
});
