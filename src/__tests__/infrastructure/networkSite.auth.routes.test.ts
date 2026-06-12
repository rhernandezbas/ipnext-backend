/**
 * FIX-5: /api/network-sites auth guard tests.
 *
 * Guards that the route is protected by createAuthMiddleware:
 * - GET/POST/PUT/DELETE without auth_token cookie → 401
 * - With auth_token cookie → request proceeds past auth (200/404/etc)
 *
 * Pattern mirrors featureFlags.routes.rbac.test.ts — EchoAuthProvider + cookie token = userId.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createNetworkSiteRouter } from '../../infrastructure/http/routes/networkSite.routes';
import { createAuthMiddleware } from '../../infrastructure/http/middleware/authMiddleware';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { ListNetworkSites } from '../../application/use-cases/ListNetworkSites';
import { GetNetworkSite } from '../../application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '../../application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '../../application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '../../application/use-cases/DeleteNetworkSite';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryUispSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import type { AuthProvider } from '../../domain/ports/AuthProvider';
import type { User } from '../../domain/entities/auth';
import type { NetworkSite } from '../../domain/entities/networkSite';

class EchoAuthProvider implements AuthProvider {
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
    return { id: token, username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

function makeSite(id: string): NetworkSite {
  return {
    id,
    siteNumber: 1,
    fixedCode: 'NODO 1',
    name: `Site ${id}`,
    address: 'Calle Test 1',
    city: 'Buenos Aires',
    coordinates: null,
    type: 'nodo',
    status: 'active',
    deviceCount: 0,
    clientCount: 0,
    uplink: '',
    parentSiteId: null,
    description: '',
    iclassNodeCode: null,
    uispSiteId: null,
  };
}

function buildApp() {
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([makeSite('ns-auth-1')]);
  const uispSiteRepo = new InMemoryUispSiteRepository();
  const authProvider = new EchoAuthProvider();

  const listNS   = new ListNetworkSites(networkSiteRepo);
  const getNS    = new GetNetworkSite(networkSiteRepo);
  const createNS = new CreateNetworkSite(networkSiteRepo);
  const updateNS = new UpdateNetworkSite(networkSiteRepo, uispSiteRepo);
  const deleteNS = new DeleteNetworkSite(networkSiteRepo);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Mirror the production mount: auth middleware BEFORE router
  app.use(
    '/api/network-sites',
    createAuthMiddleware(authProvider),
    createNetworkSiteRouter(listNS, getNS, createNS, updateNS, deleteNS),
  );
  app.use(errorHandler);
  return app;
}

describe('FIX-5: /api/network-sites auth guard', () => {
  it('GET /api/network-sites without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/network-sites');
    expect(res.status).toBe(401);
  });

  it('GET /api/network-sites/:id without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/network-sites/ns-auth-1');
    expect(res.status).toBe(401);
  });

  it('POST /api/network-sites without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/network-sites').send({ name: 'x' });
    expect(res.status).toBe(401);
  });

  it('PUT /api/network-sites/:id without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).put('/api/network-sites/ns-auth-1').send({ name: 'y' });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/network-sites/:id without auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/network-sites/ns-auth-1');
    expect(res.status).toBe(401);
  });

  it('GET /api/network-sites with valid auth_token cookie → 200', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/network-sites')
      .set('Cookie', 'auth_token=user-1');
    expect(res.status).toBe(200);
  });

  it('PUT /api/network-sites/:id with valid auth_token cookie → proceeds past auth', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/network-sites/ns-auth-1')
      .set('Cookie', 'auth_token=user-1')
      .send({ name: 'Updated Name' });
    // 200 means auth passed and update succeeded
    expect(res.status).toBe(200);
  });
});
