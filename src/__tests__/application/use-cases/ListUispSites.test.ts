/**
 * ListUispSites — SCEN-API-01, SCEN-API-02.
 */
import { ListUispSites } from '../../../application/use-cases/ListUispSites';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import type { UispSite } from '../../../domain/entities/uisp';

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: `internal-${uispId}`,
    uispId,
    name: `Site ${uispId}`,
    status: 'unknown',
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

describe('ListUispSites', () => {
  // SCEN-API-01: 200 with sites
  it('SCEN-API-01: returns all sites from the repository', async () => {
    const repo = new InMemoryUispSiteRepository();
    repo.seed(makeSite('site-1'));
    repo.seed(makeSite('site-2'));

    const uc = new ListUispSites(repo);
    const result = await uc.execute();

    expect(result.sites).toHaveLength(2);
    expect(result.sites[0].uispId).toBeDefined();
    expect(result.sites[0].name).toBeDefined();
  });

  it('SCEN-API-01: returned rows include all UispSiteRow fields', async () => {
    const repo = new InMemoryUispSiteRepository();
    repo.seed(makeSite('site-1', { deviceCount: 10, outageCount: 3 }));

    const uc = new ListUispSites(repo);
    const result = await uc.execute();

    const row = result.sites[0];
    expect(row.uispId).toBe('site-1');
    expect(row.name).toBe('Site site-1');
    expect(row.status).toBe('unknown');
    expect(row.deviceCount).toBe(10);
    expect(row.outageCount).toBe(3);
    expect(row.lastSyncAt).toBeDefined();
    expect('missingSince' in row).toBe(true);
  });

  // SCEN-API-02: status "unknown" served as-is (not flagged as error)
  it('SCEN-API-02: status "unknown" is returned as-is without transformation', async () => {
    const repo = new InMemoryUispSiteRepository();
    repo.seed(makeSite('site-1', { status: 'unknown' }));

    const uc = new ListUispSites(repo);
    const result = await uc.execute();

    expect(result.sites[0].status).toBe('unknown');
  });

  it('returns empty sites array when no sites in mirror', async () => {
    const repo = new InMemoryUispSiteRepository();
    const uc = new ListUispSites(repo);
    const result = await uc.execute();
    expect(result.sites).toHaveLength(0);
  });
});
