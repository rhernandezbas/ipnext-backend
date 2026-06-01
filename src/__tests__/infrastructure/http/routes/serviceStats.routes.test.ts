/**
 * serviceStats.routes.test.ts — supertest for GET /api/services/stats.
 * Verifies that the endpoint returns { total, byStatus } correctly,
 * requires auth, and is mounted BEFORE the /:id catch-all.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createServicesRouter } from '@infrastructure/http/routes/services.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceRepository';
import { ListServices } from '@application/use-cases/ListServices';
import { GetServiceStats } from '@application/use-cases/GetServiceStats';

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
  const getServiceStats = new GetServiceStats(repo);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createServicesRouter(authProvider, listServices, getServiceStats));
  app.use(errorHandler);

  return { app, repo };
}

describe('GET /api/services/stats', () => {
  it('returns 401 when unauthenticated', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/services/stats');
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty stats when no services exist', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/services/stats').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, byStatus: {} });
  });

  it('returns correct total and byStatus aggregation', async () => {
    const { app, repo } = buildApp();
    repo.seed({ clientName: 'A', plan: 'P1', status: 'Vigente' });
    repo.seed({ clientName: 'B', plan: 'P2', status: 'Vigente' });
    repo.seed({ clientName: 'C', plan: 'P3', status: 'Baja' });
    const res = await request(app).get('/api/services/stats').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byStatus).toEqual({ Vigente: 2, Baja: 1 });
  });

  it('response shape matches { total: number, byStatus: object }', async () => {
    const { app, repo } = buildApp();
    repo.seed({ clientName: 'X', plan: 'P', status: 'Vigente' });
    const res = await request(app).get('/api/services/stats').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['byStatus', 'total']);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.byStatus).toBe('object');
  });

  it('/stats is NOT swallowed by the /:id listing route (route order guard)', async () => {
    // This test guarantees /stats is matched before any /:id catch-all.
    // If this returns 404 or the listing shape, /stats is mounted in the wrong order.
    const { app } = buildApp();
    const res = await request(app).get('/api/services/stats').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('byStatus');
  });
});
