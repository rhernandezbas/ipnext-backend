/**
 * NetworkSite uispSiteId routes tests — SCEN-NS-01..05
 *
 * TDD RED phase: tests written before implementation.
 *
 * SCEN-NS-01: PUT /api/network-sites/:id with valid uispSiteId → 200, field persisted
 * SCEN-NS-02: PUT /api/network-sites/:id with uispSiteId that doesn't exist in mirror → 422 UISP_SITE_NOT_FOUND
 * SCEN-NS-03: PUT /api/network-sites/:id with uispSiteId: null → 200, field cleared (delink)
 * SCEN-NS-04: PUT /api/network-sites/:id without uispSiteId → 200, other fields updated, uispSiteId untouched
 * SCEN-NS-05: GET /api/uisp/sites/:uispId includes linkedNetworkSite when linked
 */
import request from 'supertest';
import express from 'express';

import { createNetworkSiteRouter } from '../../infrastructure/http/routes/networkSite.routes';
import { createUispRouter } from '../../infrastructure/http/routes/uisp.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { UpdateNetworkSite } from '../../application/use-cases/UpdateNetworkSite';
import { GetNetworkSite } from '../../application/use-cases/GetNetworkSite';
import { ListNetworkSites } from '../../application/use-cases/ListNetworkSites';
import { CreateNetworkSite } from '../../application/use-cases/CreateNetworkSite';
import { DeleteNetworkSite } from '../../application/use-cases/DeleteNetworkSite';
import { GetUispSiteDetail } from '../../application/use-cases/GetUispSiteDetail';
import { ListUispSites } from '../../application/use-cases/ListUispSites';
import { GetUispSyncStatus } from '../../application/use-cases/GetUispSyncStatus';
import { TriggerUispSync } from '../../application/use-cases/TriggerUispSync';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryUispSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import type { NetworkSite } from '../../domain/entities/networkSite';
import type { UispSite } from '../../domain/entities/uisp';
import type { UispSyncScheduler } from '../../infrastructure/scheduling/UispSyncScheduler';

const now = new Date('2026-06-20T00:00:00Z');

function makeSite(id: string, overrides: Partial<NetworkSite> = {}): NetworkSite {
  return {
    id,
    name: `Site ${id}`,
    address: 'Calle Test 123',
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
    ...overrides,
  };
}

function makeUispSite(uispId: string): UispSite {
  return {
    id: `internal-${uispId}`,
    uispId,
    name: `UISP Site ${uispId}`,
    status: 'active',
    parentUispId: null,
    latitude: -34.89844,
    longitude: -60.01962,
    deviceCount: 3,
    outageCount: 0,
    contact: null,
    address: null,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

interface Fixture {
  app: express.Express;
  networkSiteRepo: InMemoryNetworkSiteRepository;
  uispSiteRepo: InMemoryUispSiteRepository;
}

function buildFixture(): Fixture {
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  // Seed a fresh site (no uispSiteId)
  networkSiteRepo.seedSites([makeSite('site-ns-1')]);

  const uispSiteRepo = new InMemoryUispSiteRepository();
  uispSiteRepo.seed(makeUispSite('uisp-site-abc'));

  const uispDeviceRepo = new InMemoryUispDeviceRepository();
  const syncState = new InMemorySyncStateRepository();
  const flags = new InMemoryFeatureFlagRepository();

  // Use cases — NS
  const listNS     = new ListNetworkSites(networkSiteRepo);
  const getNS      = new GetNetworkSite(networkSiteRepo);
  const createNS   = new CreateNetworkSite(networkSiteRepo);
  const updateNS   = new UpdateNetworkSite(networkSiteRepo, uispSiteRepo);
  const deleteNS   = new DeleteNetworkSite(networkSiteRepo);

  // Use cases — UISP
  const listSites     = new ListUispSites(uispSiteRepo);
  const getSiteDetail = new GetUispSiteDetail(uispSiteRepo, uispDeviceRepo, networkSiteRepo);
  const getSyncStatus = new GetUispSyncStatus(syncState, flags, true);
  const scheduler     = { triggerNow: async () => ({ queued: true as const }) } as unknown as UispSyncScheduler;
  const triggerSync   = new TriggerUispSync(scheduler);

  const app = express();
  app.use(express.json());
  app.use('/api/network-sites', createNetworkSiteRouter(listNS, getNS, createNS, updateNS, deleteNS));
  app.use(
    '/api/uisp',
    createUispRouter(
      listSites,
      getSiteDetail,
      getSyncStatus,
      triggerSync,
      (_req, _res, next) => next(), // open middleware for tests
      (_req, _res, next) => next(),
    ),
  );
  app.use(errorHandler);

  return { app, networkSiteRepo, uispSiteRepo };
}

describe('NetworkSite uispSiteId routes', () => {
  // SCEN-NS-01: valid uispSiteId → 200, field persisted
  it('SCEN-NS-01: PUT with valid uispSiteId → 200, uispSiteId persisted', async () => {
    const { app } = buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-ns-1')
      .send({ name: 'Site Updated', uispSiteId: 'uisp-site-abc' });
    expect(res.status).toBe(200);
    expect(res.body.uispSiteId).toBe('uisp-site-abc');
  });

  // SCEN-NS-02: uispSiteId not in mirror → 422 UISP_SITE_NOT_FOUND
  it('SCEN-NS-02: PUT with unknown uispSiteId → 422 UISP_SITE_NOT_FOUND', async () => {
    const { app } = buildFixture();
    const res = await request(app)
      .put('/api/network-sites/site-ns-1')
      .send({ uispSiteId: 'does-not-exist' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('UISP_SITE_NOT_FOUND');
  });

  // SCEN-NS-03: uispSiteId: null → 200, field cleared
  it('SCEN-NS-03: PUT with uispSiteId: null → 200, delinks (null)', async () => {
    const { app, networkSiteRepo } = buildFixture();
    // First link it
    networkSiteRepo.seedSites([makeSite('site-ns-1', { uispSiteId: 'uisp-site-abc' })]);
    const res = await request(app)
      .put('/api/network-sites/site-ns-1')
      .send({ uispSiteId: null });
    expect(res.status).toBe(200);
    expect(res.body.uispSiteId).toBeNull();
  });

  // SCEN-NS-04: no uispSiteId in body → 200, other fields updated, uispSiteId unchanged
  it('SCEN-NS-04: PUT without uispSiteId → 200, uispSiteId not modified', async () => {
    const { app, networkSiteRepo } = buildFixture();
    networkSiteRepo.seedSites([makeSite('site-ns-1', { uispSiteId: 'uisp-site-abc' })]);
    const res = await request(app)
      .put('/api/network-sites/site-ns-1')
      .send({ name: 'Name Changed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Name Changed');
    expect(res.body.uispSiteId).toBe('uisp-site-abc');
  });

  // SCEN-NS-05: GET /api/uisp/sites/:uispId includes linkedNetworkSite
  it('SCEN-NS-05: GET /api/uisp/sites/:uispId → includes linkedNetworkSite when linked', async () => {
    const { app, networkSiteRepo } = buildFixture();
    // Link site-ns-1 → uisp-site-abc
    networkSiteRepo.seedSites([makeSite('site-ns-1', { uispSiteId: 'uisp-site-abc', name: 'Nodo Central' })]);
    const res = await request(app).get('/api/uisp/sites/uisp-site-abc');
    expect(res.status).toBe(200);
    expect(res.body.site.linkedNetworkSite).toBeDefined();
    expect(res.body.site.linkedNetworkSite.id).toBe('site-ns-1');
    expect(res.body.site.linkedNetworkSite.name).toBe('Nodo Central');
  });

  it('GET /api/uisp/sites/:uispId → linkedNetworkSite is null when no link', async () => {
    const { app } = buildFixture();
    const res = await request(app).get('/api/uisp/sites/uisp-site-abc');
    expect(res.status).toBe(200);
    expect(res.body.site.linkedNetworkSite).toBeNull();
  });
});
