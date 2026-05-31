/**
 * services.routes.test.ts — supertest for GET /api/services (contracts page).
 * Verifies the response envelope and item shape match the frontend contract
 * exactly: PaginatedResponse<ContractSummary> = { data, total, page, pageSize, totalPages }.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createServicesRouter } from '@infrastructure/http/routes/services.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceRepository';
import { ListServices } from '@application/use-cases/ListServices';

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
  repo: InMemoryServiceRepository;
}

function buildApp(authFail = false): Harness {
  const repo = new InMemoryServiceRepository();
  const authProvider = new FakeAuthProvider(authFail);
  const listServices = new ListServices(repo);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createServicesRouter(authProvider, listServices));
  app.use(errorHandler);

  return { app, repo };
}

describe('GET /api/services', () => {
  it('returns 200 with an empty paginated envelope', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/services').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0, page: 1, pageSize: 25, totalPages: 1 });
  });

  it('returns 200 with ContractSummary items matching the FE shape', async () => {
    const { app, repo } = buildApp();
    repo.seed({ clientName: 'Acme Corp', plan: 'Fiber 100', status: 'active', technology: 'Fiber', startDate: '2024-01-10T00:00:00.000Z' });
    const res = await request(app).get('/api/services').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      clientName: 'Acme Corp',
      plan: 'Fiber 100',
      status: 'active',
      technology: 'Fiber',
      startDate: '2024-01-10T00:00:00.000Z',
    });
    expect(Object.keys(res.body).sort()).toEqual(['data', 'page', 'pageSize', 'total', 'totalPages']);
  });

  it('filters by status', async () => {
    const { app, repo } = buildApp();
    repo.seed({ clientName: 'A', plan: 'P1', status: 'active' });
    repo.seed({ clientName: 'B', plan: 'P2', status: 'blocked' });
    const res = await request(app).get('/api/services?status=blocked').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].status).toBe('blocked');
  });

  it('filters by technology', async () => {
    const { app, repo } = buildApp();
    repo.seed({ clientName: 'A', plan: 'P1', technology: 'Fiber' });
    repo.seed({ clientName: 'B', plan: 'P2', technology: 'Wireless' });
    const res = await request(app).get('/api/services?technology=Wireless').set('Cookie', AUTH_COOKIE);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].technology).toBe('Wireless');
  });

  it('searches by plan or client name', async () => {
    const { app, repo } = buildApp();
    repo.seed({ clientName: 'Juan Pérez', plan: 'Fiber 100' });
    repo.seed({ clientName: 'Other', plan: 'Wireless 50' });
    const res = await request(app).get('/api/services?search=juan').set('Cookie', AUTH_COOKIE);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].clientName).toBe('Juan Pérez');
  });

  it('paginates via page and limit query params', async () => {
    const { app, repo } = buildApp();
    for (let i = 0; i < 5; i++) repo.seed({ clientName: `C${i}`, plan: `P${i}` });
    const res = await request(app).get('/api/services?page=2&limit=2').set('Cookie', AUTH_COOKIE);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(2);
    expect(res.body.totalPages).toBe(3);
    expect(res.body.data).toHaveLength(2);
  });

  it('returns 401 when unauthenticated', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/services');
    expect(res.status).toBe(401);
  });
});
