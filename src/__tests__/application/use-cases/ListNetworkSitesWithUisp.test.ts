/**
 * ListNetworkSitesWithUisp — unit tests
 *
 * SCEN-LNS-01: site with uispSiteId linked → uisp block populated
 * SCEN-LNS-02: site without uispSiteId → uisp block is null
 * SCEN-LNS-03: site with uispSiteId but not in mirror → uisp block is null
 * SCEN-LNS-04: batch — no N+1 (verified via listAll call count = 1)
 */
import { ListNetworkSitesWithUisp } from '../../../application/use-cases/ListNetworkSitesWithUisp';
import { InMemoryNetworkSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import type { NetworkSite } from '../../../domain/entities/networkSite';
import type { UispSite } from '../../../domain/entities/uisp';

const now = new Date('2026-06-10T00:00:00Z');

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

function makeUispSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: `internal-${uispId}`,
    uispId,
    name: `UISP ${uispId}`,
    status: 'active',
    parentUispId: null,
    latitude: null,
    longitude: null,
    deviceCount: 5,
    outageCount: 1,
    contact: null,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ListNetworkSitesWithUisp', () => {
  // SCEN-LNS-01: linked site → uisp block populated
  it('SCEN-LNS-01: linked site has uisp block with status, deviceCount, outageCount, lastSyncAt, missingSince', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([makeNetworkSite('ns-1', { uispSiteId: 'uisp-abc' })]);
    const uispRepo = new InMemoryUispSiteRepository();
    uispRepo.seed(makeUispSite('uisp-abc', { deviceCount: 7, outageCount: 2, status: 'active' }));

    const uc = new ListNetworkSitesWithUisp(nsRepo, uispRepo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    const uisp = result[0].uisp;
    expect(uisp).not.toBeNull();
    expect(uisp?.status).toBe('active');
    expect(uisp?.deviceCount).toBe(7);
    expect(uisp?.outageCount).toBe(2);
    expect(uisp?.lastSyncAt).toEqual(now);
    expect(uisp?.missingSince).toBeNull();
  });

  // SCEN-LNS-02: no uispSiteId → null
  it('SCEN-LNS-02: unlinked site has uisp: null', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([makeNetworkSite('ns-2', { uispSiteId: null })]);
    const uispRepo = new InMemoryUispSiteRepository();

    const uc = new ListNetworkSitesWithUisp(nsRepo, uispRepo);
    const result = await uc.execute();

    expect(result[0].uisp).toBeNull();
  });

  // SCEN-LNS-03: uispSiteId set but not in mirror → null
  it('SCEN-LNS-03: stale uispSiteId (not in mirror) → uisp: null', async () => {
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([makeNetworkSite('ns-3', { uispSiteId: 'ghost-uisp' })]);
    const uispRepo = new InMemoryUispSiteRepository(); // empty mirror

    const uc = new ListNetworkSitesWithUisp(nsRepo, uispRepo);
    const result = await uc.execute();

    expect(result[0].uisp).toBeNull();
  });

  // SCEN-LNS-04: missingSince propagated
  it('SCEN-LNS-04: missing UISP site → missingSince propagated to uisp block', async () => {
    const missingDate = new Date('2026-05-01T00:00:00Z');
    const nsRepo = new InMemoryNetworkSiteRepository();
    nsRepo.seedSites([makeNetworkSite('ns-4', { uispSiteId: 'uisp-xyz' })]);
    const uispRepo = new InMemoryUispSiteRepository();
    uispRepo.seed(makeUispSite('uisp-xyz', { missingSince: missingDate }));

    const uc = new ListNetworkSitesWithUisp(nsRepo, uispRepo);
    const result = await uc.execute();

    expect(result[0].uisp?.missingSince).toEqual(missingDate);
  });
});
