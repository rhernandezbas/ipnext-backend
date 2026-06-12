/**
 * network-site-fixed-code (#51) — InMemoryNetworkSiteRepository siteNumber behavior.
 *
 * REQ-SN-1: create() assigns incremental siteNumber (first call → 6, second → 7, ...)
 * REQ-SN-2: created site has fixedCode === "NODO {siteNumber}"
 * REQ-SN-3: seedSites with a high siteNumber advances the sequence, so the
 *            next create() does NOT collide with seeded siteNumbers.
 * REQ-SN-4: two creates from a fresh (empty-seeded) repo get different siteNumbers.
 */
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import type { NetworkSite } from '../../domain/entities/networkSite';

function siteInput(name: string): Omit<NetworkSite, 'id' | 'siteNumber' | 'fixedCode'> {
  return {
    name,
    address: 'Test 123',
    city: 'Test City',
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

describe('InMemoryNetworkSiteRepository — siteNumber + fixedCode on create()', () => {
  it('REQ-SN-1: first create on empty-seeded repo gets siteNumber 6 (default sequence)', async () => {
    const repo = new InMemoryNetworkSiteRepository();
    repo.seedSites([]);
    const site = await repo.create(siteInput('Alpha'));
    expect(site.siteNumber).toBe(6);
  });

  it('REQ-SN-2: created site has fixedCode === "NODO {siteNumber}"', async () => {
    const repo = new InMemoryNetworkSiteRepository();
    repo.seedSites([]);
    const site = await repo.create(siteInput('Beta'));
    expect(site.fixedCode).toBe(`NODO ${site.siteNumber}`);
  });

  it('REQ-SN-4: two creates from empty-seeded repo get different, consecutive siteNumbers', async () => {
    const repo = new InMemoryNetworkSiteRepository();
    repo.seedSites([]);
    const first = await repo.create(siteInput('First'));
    const second = await repo.create(siteInput('Second'));
    expect(second.siteNumber).toBe(first.siteNumber + 1);
    expect(second.fixedCode).toBe(`NODO ${second.siteNumber}`);
  });

  it('REQ-SN-3: seedSites with high siteNumber advances sequence so create() does not collide', async () => {
    const repo = new InMemoryNetworkSiteRepository();
    // Seed a site with siteNumber 100 — sequence should advance past it
    const seeded: NetworkSite = {
      id: 'seeded-1',
      siteNumber: 100,
      fixedCode: 'NODO 100',
      name: 'Seeded Site',
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
    };
    repo.seedSites([seeded]);
    const created = await repo.create(siteInput('After High Seed'));
    // Must not collide with siteNumber 100
    expect(created.siteNumber).not.toBe(100);
    expect(created.siteNumber).toBeGreaterThan(100);
    expect(created.fixedCode).toBe(`NODO ${created.siteNumber}`);
  });
});
