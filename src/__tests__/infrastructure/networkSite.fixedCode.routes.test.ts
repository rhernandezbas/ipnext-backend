/**
 * network-site-fixed-code (#51) — Route PUT immutability test.
 *
 * REQ-FC-IMMUTABLE-1: PUT with { siteNumber, fixedCode, name } does NOT change
 *   siteNumber or fixedCode of the site — only writable fields (name) are updated.
 *
 * Uses InMemoryNetworkSiteRepository + real Express app (no Prisma).
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
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryUispSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import type { NetworkSite } from '../../domain/entities/networkSite';

const SEED_SITE: NetworkSite = {
  id: 'site-fc-001',
  siteNumber: 42,
  fixedCode: 'NODO 42',
  name: 'Original Name',
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

function buildApp() {
  const repo = new InMemoryNetworkSiteRepository();
  repo.seedSites([SEED_SITE]);

  const uispRepo = new InMemoryUispSiteRepository();

  const app = express();
  app.use(express.json());

  const router = createNetworkSiteRouter(
    new ListNetworkSites(repo),
    new GetNetworkSite(repo),
    new CreateNetworkSite(repo),
    new UpdateNetworkSite(repo, uispRepo),
    new DeleteNetworkSite(repo),
  );

  app.use('/api/network-sites', router);
  app.use(errorHandler);

  return { app, repo };
}

describe('PUT /api/network-sites/:id — siteNumber/fixedCode are immutable (REQ-FC-IMMUTABLE-1)', () => {
  it('ignores siteNumber and fixedCode in body — they stay unchanged', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .put('/api/network-sites/site-fc-001')
      .send({ name: 'Updated Name', siteNumber: 999, fixedCode: 'NODO 999' });

    expect(res.status).toBe(200);
    // name changed
    expect(res.body.name).toBe('Updated Name');
    // siteNumber and fixedCode must be the originals
    expect(res.body.siteNumber).toBe(42);
    expect(res.body.fixedCode).toBe('NODO 42');
  });
});
