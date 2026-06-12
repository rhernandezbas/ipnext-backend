/**
 * NetworkSite PUT iclassNodeId routes — REQ-NCAT-3.
 * Conditional delegation in PUT /api/network-sites/:id (pattern projects.routes):
 *   - body has iclassNodeId (uuid) → AssignIClassNodeToNetworkSite → sets code+city
 *   - body has iclassNodeId: null → clears only iclassNodeCode (city intact)
 *   - non-selectable / inactive node → 422 ICLASS_NODE_NOT_ASSIGNABLE
 *   - body WITHOUT iclassNodeId (free-text iclassNodeCode) → legacy updateNetworkSite
 */
import request from 'supertest';
import express from 'express';

import { createNetworkSiteRouter } from '../../infrastructure/http/routes/networkSite.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { ListNetworkSites } from '../../application/use-cases/ListNetworkSites';
import { GetNetworkSite } from '../../application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '../../application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '../../application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '../../application/use-cases/DeleteNetworkSite';
import { AssignIClassNodeToNetworkSite } from '../../application/use-cases/AssignIClassNodeToNetworkSite';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryIClassNodeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';
import type { NetworkSite } from '../../domain/entities/networkSite';

function makeSite(id: string, overrides: Partial<NetworkSite> = {}): NetworkSite {
  return {
    id,
    siteNumber: 1,
    fixedCode: 'NODO 1',
    name: `Site ${id}`,
    address: 'Calle Test 123',
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

async function buildFixture() {
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([makeSite('site-1')]);

  const nodeRepo = new InMemoryIClassNodeRepository();
  await nodeRepo.upsertByNodeId({ nodeId: 1, code: 'Mercedes', description: 'Mercedes', selectable: true });
  await nodeRepo.upsertByNodeId({ nodeId: 2, code: 'Main', description: 'Main', selectable: false });
  const nodes = await nodeRepo.list();
  const mercedes = nodes.find(n => n.code === 'Mercedes')!;
  const main = nodes.find(n => n.code === 'Main')!;

  const listNS = new ListNetworkSites(networkSiteRepo);
  const getNS = new GetNetworkSite(networkSiteRepo);
  const createNS = new CreateNetworkSite(networkSiteRepo);
  const updateNS = new UpdateNetworkSite(networkSiteRepo);
  const deleteNS = new DeleteNetworkSite(networkSiteRepo);
  const assignNode = new AssignIClassNodeToNetworkSite(networkSiteRepo, nodeRepo);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/network-sites',
    createNetworkSiteRouter(listNS, getNS, createNS, updateNS, deleteNS, undefined, assignNode),
  );
  app.use(errorHandler);

  return { app, networkSiteRepo, mercedes, main };
}

describe('PUT /api/network-sites/:id with iclassNodeId', () => {
  it('valid node uuid → 200, iclassNodeCode AND city set to node.code', async () => {
    const { app, mercedes } = await buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-1')
      .send({ iclassNodeId: mercedes.id });
    expect(res.status).toBe(200);
    expect(res.body.iclassNodeCode).toBe('Mercedes');
    expect(res.body.city).toBe('Mercedes');
  });

  it('iclassNodeId: null → 200, clears iclassNodeCode, city intact', async () => {
    const { app } = await buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-1')
      .send({ iclassNodeId: null });
    expect(res.status).toBe(200);
    expect(res.body.iclassNodeCode).toBeNull();
    expect(res.body.city).toBe('Lujan');
  });

  it('non-selectable (grouping) node → 422 ICLASS_NODE_NOT_ASSIGNABLE', async () => {
    const { app, main } = await buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-1')
      .send({ iclassNodeId: main.id });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_NODE_NOT_ASSIGNABLE');
    expect(res.body.reason).toBeDefined();
  });

  it('unknown site with iclassNodeId → 404', async () => {
    const { app, mercedes } = await buildFixture();
    const res = await request(app)
      .put('/api/network-sites/nope')
      .send({ iclassNodeId: mercedes.id });
    expect(res.status).toBe(404);
  });

  it('backward-compat: PUT with free-text iclassNodeCode (no iclassNodeId) → 200, no validation', async () => {
    const { app } = await buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-1')
      .send({ iclassNodeCode: 'CUSTOM-NODE' });
    expect(res.status).toBe(200);
    expect(res.body.iclassNodeCode).toBe('CUSTOM-NODE');
  });

  it('iclassNodeId + other fields → assigns node AND updates the rest', async () => {
    const { app, mercedes } = await buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-1')
      .send({ iclassNodeId: mercedes.id, name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.iclassNodeCode).toBe('Mercedes');
    expect(res.body.name).toBe('Renamed');
  });

  // H1: a manual `city` in the same PUT must NOT override the node-derived city.
  // The assign use case sets city = node.code (Mercedes); the leftover `rest` that
  // falls through to updateNetworkSite must be stripped of city/iclassNodeCode so it
  // cannot clobber the assignment. Persisted city wins for the NODE, not the body.
  it('iclassNodeId + manual city → city follows the node, not the body', async () => {
    const { app, networkSiteRepo, mercedes } = await buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-1')
      .send({ iclassNodeId: mercedes.id, city: 'Lujan', name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.iclassNodeCode).toBe('Mercedes');
    expect(res.body.city).toBe('Mercedes');
    expect(res.body.name).toBe('Renamed');
    // Persisted state, not just the response: city must be the node's, never "Lujan".
    const persisted = await networkSiteRepo.findById('site-1');
    expect(persisted?.city).toBe('Mercedes');
    expect(persisted?.iclassNodeCode).toBe('Mercedes');
  });
});
