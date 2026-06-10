/**
 * Port contract test: verifies InMemoryUispSiteRepository (and by structural parity,
 * PrismaUispSiteRepository) implement the UispSiteRepository port correctly.
 *
 * These are pure in-memory tests — no DB needed. They pin the contract so if the port
 * interface changes, the in-memory impl fails first (fast feedback loop).
 */
import { InMemoryUispSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import type { UispSiteRepository } from '../../domain/ports/UispSiteRepository';
import type { UispSite } from '../../domain/entities/uisp';

function makeRepo(): InMemoryUispSiteRepository {
  return new InMemoryUispSiteRepository();
}

function makeSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  const now = new Date('2026-06-10T00:00:00Z');
  return {
    id: `internal-${uispId}`,
    uispId,
    name: `Site ${uispId}`,
    status: 'unknown',
    parentUispId: null,
    latitude: null,
    longitude: null,
    deviceCount: 0,
    outageCount: 0,
    contact: null,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Type assertion: InMemoryUispSiteRepository satisfies UispSiteRepository
const _typeCheck: UispSiteRepository = makeRepo();
void _typeCheck;

describe('InMemoryUispSiteRepository — port contract', () => {
  it('upsert creates a new site', async () => {
    const repo = makeRepo();
    const site = makeSite('site-1');
    await repo.upsert(site);
    const result = await repo.findByUispId('site-1');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Site site-1');
  });

  it('upsert is idempotent — subsequent upsert updates the existing row', async () => {
    const repo = makeRepo();
    const site = makeSite('site-1');
    await repo.upsert(site);
    const updated = { ...site, name: 'Updated Site', deviceCount: 10 };
    await repo.upsert(updated);

    const result = await repo.findByUispId('site-1');
    expect(result?.name).toBe('Updated Site');
    expect(result?.deviceCount).toBe(10);

    const all = await repo.listAll();
    expect(all).toHaveLength(1); // no duplicate
  });

  it('listAll returns all sites', async () => {
    const repo = makeRepo();
    await repo.upsert(makeSite('site-1'));
    await repo.upsert(makeSite('site-2'));
    await repo.upsert(makeSite('site-3'));
    const all = await repo.listAll();
    expect(all).toHaveLength(3);
  });

  it('findByUispId returns null for unknown uispId', async () => {
    const repo = makeRepo();
    const result = await repo.findByUispId('nonexistent');
    expect(result).toBeNull();
  });

  it('markMissing sets missingSince on matching sites', async () => {
    const repo = makeRepo();
    const since = new Date('2026-06-10T12:00:00Z');
    await repo.upsert(makeSite('site-1'));
    await repo.upsert(makeSite('site-2'));

    await repo.markMissing(['site-1'], since);

    const s1 = await repo.findByUispId('site-1');
    const s2 = await repo.findByUispId('site-2');
    expect(s1?.missingSince).toEqual(since);
    expect(s2?.missingSince).toBeNull();
  });

  it('markMissing does not overwrite existing missingSince (once set, stays)', async () => {
    const repo = makeRepo();
    const since1 = new Date('2026-06-10T12:00:00Z');
    const since2 = new Date('2026-06-10T13:00:00Z');
    await repo.upsert(makeSite('site-1'));
    await repo.markMissing(['site-1'], since1);
    await repo.markMissing(['site-1'], since2); // should not overwrite

    const s1 = await repo.findByUispId('site-1');
    expect(s1?.missingSince).toEqual(since1); // original value preserved
  });

  it('clearMissing clears missingSince for matching sites', async () => {
    const repo = makeRepo();
    const since = new Date('2026-06-10T12:00:00Z');
    await repo.upsert(makeSite('site-1'));
    await repo.markMissing(['site-1'], since);

    await repo.clearMissing(['site-1']);

    const s1 = await repo.findByUispId('site-1');
    expect(s1?.missingSince).toBeNull();
  });

  it('clearMissing is a no-op for sites not in the list', async () => {
    const repo = makeRepo();
    const since = new Date('2026-06-10T12:00:00Z');
    await repo.upsert(makeSite('site-1'));
    await repo.upsert(makeSite('site-2'));
    await repo.markMissing(['site-1', 'site-2'], since);

    await repo.clearMissing(['site-1']); // only clear site-1

    const s1 = await repo.findByUispId('site-1');
    const s2 = await repo.findByUispId('site-2');
    expect(s1?.missingSince).toBeNull();
    expect(s2?.missingSince).toEqual(since); // site-2 unchanged
  });
});
