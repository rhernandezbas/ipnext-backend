/**
 * Composition sanity test (nodes-city-mapper #45) — mirrors projects-composition.
 * Verifies the IClass node catalog routes mount under /api/admin/iclass and that
 * PUT /api/network-sites/:id accepts `iclassNodeId` with the assign use case wired.
 * Uses in-memory repos + real routers/use-cases (no DB).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createIClassAdminRouter } from '../infrastructure/http/routes/iclass-admin.routes';
import { createNetworkSiteRouter } from '../infrastructure/http/routes/networkSite.routes';
import { errorHandler } from '../infrastructure/http/middleware/errorHandler';

import { InMemoryIClassNodeRepository } from '../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';
import { InMemoryIClassSoTypeRepository } from '../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';
import { InMemoryIClassClient } from '../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryNetworkSiteRepository } from '../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';

import { SyncIClassNodes } from '../application/use-cases/SyncIClassNodes';
import { ListIClassNodeCatalog } from '../application/use-cases/ListIClassNodeCatalog';
import { SyncIClassSoTypes } from '../application/use-cases/SyncIClassSoTypes';
import { ListIClassSoTypes } from '../application/use-cases/ListIClassSoTypes';
import { ListNetworkSites } from '../application/use-cases/ListNetworkSites';
import { GetNetworkSite } from '../application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '../application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '../application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '../application/use-cases/DeleteNetworkSite';
import { AssignIClassNodeToNetworkSite } from '../application/use-cases/AssignIClassNodeToNetworkSite';

import { User } from '../domain/entities/auth';
import { AuthProvider } from '../domain/ports/AuthProvider';
import type { NetworkSite } from '../domain/entities/networkSite';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'a', username: 't', email: 't@t.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'a', username: 't', email: 't@t.com', role: 'admin' };
  }
}

function makeSite(id: string, overrides: Partial<NetworkSite> = {}): NetworkSite {
  return {
    id,
    siteNumber: 1,
    fixedCode: 'NODO 1',
    name: `Site ${id}`,
    address: 'addr',
    city: 'Lujan',
    coordinates: null,
    type: 'nodo',
    status: 'active',
    deviceCount: 0,
    clientCount: 0,
    uplink: '',
    parentSiteId: null,
    description: '',
    iclassNodeCode: 'Lujan',
    uispSiteId: null,
    ...overrides,
  };
}

async function buildApp() {
  const nodeRepo = new InMemoryIClassNodeRepository();
  const soTypeRepo = new InMemoryIClassSoTypeRepository();
  const iclass = new InMemoryIClassClient();
  iclass.nodes = [
    { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
    { nodeId: 2, code: 'Main', description: 'agrupador' },
  ];
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([makeSite('site-1')]);

  // Wire exactly as app.ts does
  const syncIClassNodes = new SyncIClassNodes(iclass, nodeRepo);
  const listIClassNodeCatalog = new ListIClassNodeCatalog(nodeRepo);
  const assignIClassNodeToNetworkSite = new AssignIClassNodeToNetworkSite(networkSiteRepo, nodeRepo);
  const syncSoTypes = new SyncIClassSoTypes(iclass, soTypeRepo);
  const listSoTypes = new ListIClassSoTypes(soTypeRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassAdminRouter(
      syncSoTypes,
      listSoTypes,
      new FakeAuthProvider(),
      undefined,
      syncIClassNodes,
      listIClassNodeCatalog,
    ),
  );
  app.use(
    '/api/network-sites',
    createNetworkSiteRouter(
      new ListNetworkSites(networkSiteRepo),
      new GetNetworkSite(networkSiteRepo),
      new CreateNetworkSite(networkSiteRepo),
      new UpdateNetworkSite(networkSiteRepo),
      new DeleteNetworkSite(networkSiteRepo),
      undefined,
      assignIClassNodeToNetworkSite,
    ),
  );
  app.use(errorHandler);

  return { app, nodeRepo };
}

const COOKIE = 'auth_token=fake';

describe('Composition: IClass node catalog routes', () => {
  it('POST /api/admin/iclass/nodes/sync resolves and syncs', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/admin/iclass/nodes/sync').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(2);
  });

  it('GET /api/admin/iclass/nodes resolves to { items }', async () => {
    const { app } = await buildApp();
    await request(app).post('/api/admin/iclass/nodes/sync').set('Cookie', COOKIE);
    const res = await request(app).get('/api/admin/iclass/nodes?selectable=true').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(1); // Main excluded
  });

  it('PUT /api/network-sites/:id accepts iclassNodeId and assigns', async () => {
    const { app, nodeRepo } = await buildApp();
    await request(app).post('/api/admin/iclass/nodes/sync').set('Cookie', COOKIE);
    const mercedes = (await nodeRepo.list()).find(n => n.code === 'Mercedes')!;
    const res = await request(app)
      .put('/api/network-sites/site-1')
      .set('Cookie', COOKIE)
      .send({ iclassNodeId: mercedes.id });
    expect(res.status).toBe(200);
    expect(res.body.iclassNodeCode).toBe('Mercedes');
    expect(res.body.city).toBe('Mercedes');
  });
});
