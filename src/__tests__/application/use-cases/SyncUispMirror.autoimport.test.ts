/**
 * SyncUispMirror — auto-import NetworkSites tests (SCEN-AI-01..06)
 *
 * TDD RED→GREEN: tests written first, cover the new step-8 logic added to SyncUispMirror.
 *
 * SCEN-AI-01: UISP site without NetworkSite → NetworkSite created (name, coordinates, uispSiteId, status=active)
 * SCEN-AI-02: UISP site already linked → NO duplicate created (idempotent re-run)
 * SCEN-AI-03: Missing UISP site → existing NetworkSite kept (no auto-delete)
 * SCEN-AI-04: Coordinates NOT overwritten when NetworkSite already has coordinates (manual wins)
 * SCEN-AI-05: Coordinates set when NetworkSite has null coordinates (uisp-derived wins)
 * SCEN-AI-06: networkSitesCreated counter accurate in result
 */
import { SyncUispMirror } from '../../../application/use-cases/SyncUispMirror';
import { InMemoryUispClient } from '../../../infrastructure/adapters/in-memory/InMemoryUispClient';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemorySyncStateRepository } from '../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryNetworkSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import type { UispSite } from '../../../domain/entities/uisp';
import type { NetworkSite } from '../../../domain/entities/networkSite';

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: '',
    uispId,
    name: `Site ${uispId}`,
    status: 'active',
    parentUispId: null,
    latitude: -34.6,
    longitude: -58.4,
    deviceCount: 2,
    outageCount: 0,
    contact: null,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeNetworkSite(id: string, overrides: Partial<NetworkSite> = {}): NetworkSite {
  return {
    id,
    name: `NS ${id}`,
    address: '',
    city: '',
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

function buildUseCase(
  sites: UispSite[],
  networkSiteRepo: InMemoryNetworkSiteRepository,
) {
  const client = new InMemoryUispClient(sites, []);
  const siteRepo = new InMemoryUispSiteRepository();
  const deviceRepo = new InMemoryUispDeviceRepository();
  const syncStateRepo = new InMemorySyncStateRepository();
  const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo, networkSiteRepo);
  return { useCase, siteRepo };
}

describe('SyncUispMirror — auto-import NetworkSites', () => {
  // SCEN-AI-01: new UISP site → NetworkSite created
  it('SCEN-AI-01: creates NetworkSite for UISP site not yet linked', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]); // empty — no pre-existing sites

    const { useCase } = buildUseCase([makeSite('uisp-1')], nsRepo);
    const result = await useCase.execute();

    const all = await nsRepo.findAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Site uisp-1');
    expect(all[0].uispSiteId).toBe('uisp-1');
    expect(all[0].status).toBe('active');
    expect(all[0].coordinates).toEqual({ lat: -34.6, lng: -58.4 });
    expect(result.networkSitesCreated).toBe(1);
  });

  // SCEN-AI-02: UISP site already linked → no duplicate
  it('SCEN-AI-02: idempotent — no duplicate NetworkSite on re-run', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([makeNetworkSite('ns-1', { uispSiteId: 'uisp-1' })]);

    const { useCase } = buildUseCase([makeSite('uisp-1')], nsRepo);
    const result = await useCase.execute();

    const all = await nsRepo.findAll();
    expect(all.length).toBe(1); // still 1, no duplicate
    expect(result.networkSitesCreated).toBe(0);
  });

  // SCEN-AI-03: missing UISP site → NetworkSite kept (no delete)
  it('SCEN-AI-03: missing UISP site does NOT delete existing NetworkSite', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([makeNetworkSite('ns-1', { uispSiteId: 'uisp-1' })]);

    // site uisp-1 is now missing (not in UISP response)
    const { useCase } = buildUseCase([makeSite('uisp-2')], nsRepo);
    await useCase.execute();

    const all = await nsRepo.findAll();
    // ns-1 should still exist
    expect(all.some(s => s.id === 'ns-1')).toBe(true);
    // uisp-2 gets created
    expect(all.some(s => s.uispSiteId === 'uisp-2')).toBe(true);
    expect(all.length).toBe(2);
  });

  // SCEN-AI-04: coordinates NOT overwritten when NS already has them
  it('SCEN-AI-04: manual coordinates NOT overwritten by sync', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([
      makeNetworkSite('ns-1', {
        uispSiteId: 'uisp-1',
        coordinates: { lat: -99.0, lng: -99.0 }, // manually set
      }),
    ]);

    const { useCase } = buildUseCase([makeSite('uisp-1', { latitude: -34.6, longitude: -58.4 })], nsRepo);
    await useCase.execute();

    const all = await nsRepo.findAll();
    const ns = all.find(s => s.id === 'ns-1')!;
    // Manual coordinates must be preserved
    expect(ns.coordinates).toEqual({ lat: -99.0, lng: -99.0 });
  });

  // SCEN-AI-05: null coordinates → filled from UISP lat/lng
  it('SCEN-AI-05: null coordinates filled from UISP lat/lng on update', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([
      makeNetworkSite('ns-1', {
        uispSiteId: 'uisp-1',
        coordinates: null, // not yet set manually
      }),
    ]);

    const { useCase } = buildUseCase([makeSite('uisp-1', { latitude: -34.6, longitude: -58.4 })], nsRepo);
    await useCase.execute();

    const all = await nsRepo.findAll();
    const ns = all.find(s => s.id === 'ns-1')!;
    expect(ns.coordinates).toEqual({ lat: -34.6, lng: -58.4 });
  });

  // SCEN-AI-06: counter — multiple creates
  it('SCEN-AI-06: networkSitesCreated counts all newly created NS', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]); // empty

    const { useCase } = buildUseCase([makeSite('uisp-1'), makeSite('uisp-2'), makeSite('uisp-3')], nsRepo);
    const result = await useCase.execute();

    expect(result.networkSitesCreated).toBe(3);
    const all = await nsRepo.findAll();
    expect(all.length).toBe(3);
  });

  // SCEN-AI-07: two-tick idempotency — second execute() creates 0 sites, count stays stable.
  // This is the regression guard for the bug where uispSiteId was missing from the Prisma
  // create() data block: the first tick creates sites, but findByUispSiteId returns null on
  // the second tick because uispSiteId was never persisted → infinite re-creation per tick.
  it('SCEN-AI-07: two-tick run — second tick creates 0 sites, total count stays stable', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]); // start empty

    const uispSites = [makeSite('uisp-1'), makeSite('uisp-2')];
    const { useCase } = buildUseCase(uispSites, nsRepo);

    // First tick: creates 2 sites
    const result1 = await useCase.execute();
    expect(result1.networkSitesCreated).toBe(2);

    const afterTick1 = await nsRepo.findAll();
    expect(afterTick1.length).toBe(2);
    // Critical: created sites must have uispSiteId set (prerequisite for idempotency)
    expect(afterTick1.every(s => s.uispSiteId !== null)).toBe(true);

    // Second tick: same UISP sites returned → should create 0, total stays at 2
    const result2 = await useCase.execute();
    expect(result2.networkSitesCreated).toBe(0);

    const afterTick2 = await nsRepo.findAll();
    expect(afterTick2.length).toBe(2); // no duplicates
  });
});
