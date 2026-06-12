/**
 * SyncUispMirror — auto-import NetworkSites tests (step 8).
 *
 * Covers:
 *   SCEN-AUTO-01: NetworkSite created with address from UISP site
 *   SCEN-AUTO-02: NetworkSite created without address when UISP site has none (address null)
 *   SCEN-AUTO-03: UPDATE fills address ONLY if NetworkSite.address is empty/null (manual wins)
 *   SCEN-AUTO-04: UPDATE does NOT overwrite manually-set address
 *   SCEN-AUTO-05: Missing UISP site → no NetworkSite created
 *   SCEN-AUTO-06: Idempotent — two syncs don't create duplicate NetworkSites
 *   SCEN-AUTO-07: networkSitesCreated counter reported in result
 *   SCEN-AUTO-08: coordinates + address both filled on create when present
 */
import { SyncUispMirror } from '../../../application/use-cases/SyncUispMirror';
import { InMemoryUispClient } from '../../../infrastructure/adapters/in-memory/InMemoryUispClient';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemorySyncStateRepository } from '../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryNetworkSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import type { UispSite } from '../../../domain/entities/uisp';

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: '',
    uispId,
    name: `Site ${uispId}`,
    status: 'active',
    parentUispId: null,
    latitude: null,
    longitude: null,
    deviceCount: 0,
    outageCount: 0,
    contact: null,
    address: null,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildUseCase(sites: UispSite[], networkSiteRepo: InMemoryNetworkSiteRepository) {
  const client = new InMemoryUispClient(sites, []);
  const siteRepo = new InMemoryUispSiteRepository();
  const deviceRepo = new InMemoryUispDeviceRepository();
  const syncStateRepo = new InMemorySyncStateRepository();
  const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo, networkSiteRepo);
  return { useCase, client, siteRepo };
}

describe('SyncUispMirror — auto-import NetworkSites (step 8)', () => {
  // SCEN-AUTO-01: address from UISP travels to the created NetworkSite
  it('SCEN-AUTO-01: creates NetworkSite with address from UISP site', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]); // start empty
    const { useCase } = buildUseCase([makeSite('site-1', { address: 'Av. Corrientes 1234' })], nsRepo);
    await useCase.execute();
    const allNs = await nsRepo.findAll();
    expect(allNs).toHaveLength(1);
    expect(allNs[0].address).toBe('Av. Corrientes 1234');
    expect(allNs[0].uispSiteId).toBe('site-1');
  });

  // SCEN-AUTO-02: null address on UISP → NetworkSite created with empty address
  it('SCEN-AUTO-02: creates NetworkSite with empty address when UISP site has no address', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]);
    const { useCase } = buildUseCase([makeSite('site-1', { address: null })], nsRepo);
    await useCase.execute();
    const allNs = await nsRepo.findAll();
    expect(allNs).toHaveLength(1);
    // address should be empty string when UISP has none
    expect(allNs[0].address === '' || allNs[0].address == null).toBe(true);
  });

  // SCEN-AUTO-03: existing NetworkSite with no address → address filled from UISP
  it('SCEN-AUTO-03: fills address when NetworkSite has no address set (auto-complete)', async () => {
    const existingNs = {
      id: 'ns-1',
      siteNumber: 1,
      fixedCode: 'NODO 1',
      name: 'Site site-1',
      address: '',
      city: '',
      coordinates: null,
      type: 'nodo' as const,
      status: 'active' as const,
      deviceCount: 0,
      clientCount: 0,
      uplink: '',
      parentSiteId: null,
      description: '',
      iclassNodeCode: null,
      uispSiteId: 'site-1',
    };
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([existingNs]);
    const { useCase } = buildUseCase([makeSite('site-1', { address: 'Nueva Dirección 500' })], nsRepo);
    await useCase.execute();
    const updated = await nsRepo.findByUispSiteId('site-1');
    expect(updated?.address).toBe('Nueva Dirección 500');
  });

  // SCEN-AUTO-04: existing NetworkSite with manual address → NOT overwritten
  it('SCEN-AUTO-04: does NOT overwrite manually-set address on existing NetworkSite', async () => {
    const existingNs = {
      id: 'ns-1',
      siteNumber: 1,
      fixedCode: 'NODO 1',
      name: 'Site site-1',
      address: 'Manual Address 999',
      city: 'Buenos Aires',
      coordinates: null,
      type: 'nodo' as const,
      status: 'active' as const,
      deviceCount: 0,
      clientCount: 0,
      uplink: '',
      parentSiteId: null,
      description: '',
      iclassNodeCode: null,
      uispSiteId: 'site-1',
    };
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([existingNs]);
    const { useCase } = buildUseCase([makeSite('site-1', { address: 'UISP Address (should NOT overwrite)' })], nsRepo);
    await useCase.execute();
    const ns = await nsRepo.findByUispSiteId('site-1');
    expect(ns?.address).toBe('Manual Address 999');
  });

  // SCEN-AUTO-05: missing UISP site (missingSince set) → no NetworkSite created
  it('SCEN-AUTO-05: does not create NetworkSite for missing UISP sites', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]);
    // site with missingSince set — it won't appear in the UISP response
    // Simulate: first sync creates it, then it vanishes
    const { useCase, client } = buildUseCase([makeSite('site-1', { address: 'Some Address' }), makeSite('site-2')], nsRepo);
    await useCase.execute();
    const afterFirst = (await nsRepo.findAll()).length;

    // site-1 disappears
    client.setSites([makeSite('site-2')]);
    await useCase.execute();

    // No new NetworkSite should have been created for the missing site-1
    const afterSecond = await nsRepo.findAll();
    // site-2 should have been created on first tick (it was in the response)
    // site-1 NS was created on first tick and stays (never auto-delete)
    expect(afterSecond.length).toBe(afterFirst); // count unchanged
  });

  // SCEN-AUTO-06: idempotent — two syncs with same sites don't create duplicates
  it('SCEN-AUTO-06: idempotent — two syncs produce one NetworkSite per UISP site', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]);
    const { useCase } = buildUseCase([makeSite('site-1', { address: 'Addr 1' }), makeSite('site-2')], nsRepo);
    await useCase.execute();
    await useCase.execute();
    const all = await nsRepo.findAll();
    expect(all).toHaveLength(2);
  });

  // SCEN-AUTO-07: networkSitesCreated counter in result
  it('SCEN-AUTO-07: result.networkSitesCreated reflects new NetworkSites created', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]);
    const { useCase } = buildUseCase([makeSite('s1'), makeSite('s2')], nsRepo);
    const result = await useCase.execute();
    expect(result.networkSitesCreated).toBe(2);
  });

  // SCEN-AUTO-08: coordinates AND address both filled on create when present
  it('SCEN-AUTO-08: create includes both coordinates and address', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([]);
    const { useCase } = buildUseCase([
      makeSite('site-1', { address: 'La Plata 500', latitude: -34.9, longitude: -57.9 }),
    ], nsRepo);
    await useCase.execute();
    const ns = await nsRepo.findByUispSiteId('site-1');
    expect(ns?.address).toBe('La Plata 500');
    expect(ns?.coordinates).toEqual({ lat: -34.9, lng: -57.9 });
  });

  // No networkSiteRepo provided → no crash, networkSitesCreated = 0
  it('works without networkSiteRepo (backward compat — optional dep)', async () => {
    const client = new InMemoryUispClient([makeSite('s1')], []);
    const siteRepo = new InMemoryUispSiteRepository();
    const deviceRepo = new InMemoryUispDeviceRepository();
    const syncStateRepo = new InMemorySyncStateRepository();
    const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo);
    const result = await useCase.execute();
    expect(result.networkSitesCreated).toBe(0);
  });
});
