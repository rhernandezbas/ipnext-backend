/**
 * InMemoryAccessPointRepository — port behavior for the derived AP catalog.
 *
 * Covers:
 *   - upsertByUispDeviceId CREATE (new AP) assigns an id + timestamps
 *   - upsertByUispDeviceId UPDATE (same uispDeviceId) mutates name/mac/networkSiteId, keeps id
 *   - upsert does NOT duplicate on the same uispDeviceId
 *   - findMany returns all
 *   - findByNetworkSiteId filters by node
 *   - findById returns the AP or null
 *   - FIX-2: missingSince defaults null on create; markMissing stamps it (idempotent),
 *     clearMissing resets it
 */
import { InMemoryAccessPointRepository } from '@infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
import type { AccessPointRepository } from '@domain/ports/AccessPointRepository';

describe('InMemoryAccessPointRepository', () => {
  it('implements the AccessPointRepository port', () => {
    const repo: AccessPointRepository = new InMemoryAccessPointRepository();
    expect(typeof repo.upsertByUispDeviceId).toBe('function');
    expect(typeof repo.findMany).toBe('function');
    expect(typeof repo.findByNetworkSiteId).toBe('function');
    expect(typeof repo.findById).toBe('function');
  });

  it('upsertByUispDeviceId — CREATE assigns id + persists fields', async () => {
    const repo = new InMemoryAccessPointRepository();
    const ap = await repo.upsertByUispDeviceId({
      uispDeviceId: 'dev-1',
      networkSiteId: 'ns-1',
      name: 'AP Norte',
      mac: 'AA:BB:CC:DD:EE:01',
    });
    expect(ap.id).toBeTruthy();
    expect(ap.uispDeviceId).toBe('dev-1');
    expect(ap.networkSiteId).toBe('ns-1');
    expect(ap.name).toBe('AP Norte');
    expect(ap.mac).toBe('AA:BB:CC:DD:EE:01');
    expect(ap.createdAt).toBeInstanceOf(Date);
    expect(ap.updatedAt).toBeInstanceOf(Date);
  });

  it('upsertByUispDeviceId — CREATE allows null networkSiteId + null mac', async () => {
    const repo = new InMemoryAccessPointRepository();
    const ap = await repo.upsertByUispDeviceId({
      uispDeviceId: 'dev-2',
      networkSiteId: null,
      name: 'AP Sin Nodo',
      mac: null,
    });
    expect(ap.networkSiteId).toBeNull();
    expect(ap.mac).toBeNull();
  });

  it('upsertByUispDeviceId — UPDATE keeps id, mutates name/mac/networkSiteId (no duplicate)', async () => {
    const repo = new InMemoryAccessPointRepository();
    const created = await repo.upsertByUispDeviceId({
      uispDeviceId: 'dev-1',
      networkSiteId: null,
      name: 'AP viejo',
      mac: null,
    });
    const updated = await repo.upsertByUispDeviceId({
      uispDeviceId: 'dev-1',
      networkSiteId: 'ns-9',
      name: 'AP nuevo',
      mac: 'FF:FF:FF:FF:FF:FF',
    });
    expect(updated.id).toBe(created.id); // same row
    expect(updated.name).toBe('AP nuevo');
    expect(updated.mac).toBe('FF:FF:FF:FF:FF:FF');
    expect(updated.networkSiteId).toBe('ns-9');
    const all = await repo.findMany();
    expect(all).toHaveLength(1);
  });

  it('findMany — returns all APs', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd1', networkSiteId: 'n1', name: 'A', mac: null });
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd2', networkSiteId: 'n1', name: 'B', mac: null });
    const all = await repo.findMany();
    expect(all).toHaveLength(2);
  });

  it('findByNetworkSiteId — filters by node', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd1', networkSiteId: 'n1', name: 'A', mac: null });
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd2', networkSiteId: 'n2', name: 'B', mac: null });
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd3', networkSiteId: 'n1', name: 'C', mac: null });
    const inN1 = await repo.findByNetworkSiteId('n1');
    expect(inN1.map(a => a.uispDeviceId).sort()).toEqual(['d1', 'd3']);
  });

  it('findById — returns the AP or null', async () => {
    const repo = new InMemoryAccessPointRepository();
    const ap = await repo.upsertByUispDeviceId({ uispDeviceId: 'd1', networkSiteId: null, name: 'A', mac: null });
    expect(await repo.findById(ap.id)).not.toBeNull();
    expect(await repo.findById('nope')).toBeNull();
  });

  // FIX-2 — retired-AP state (missingSince), mirroring the UispDevice discipline
  it('upsertByUispDeviceId — CREATE sets missingSince = null by default', async () => {
    const repo = new InMemoryAccessPointRepository();
    const ap = await repo.upsertByUispDeviceId({ uispDeviceId: 'd1', networkSiteId: null, name: 'A', mac: null });
    expect(ap.missingSince).toBeNull();
  });

  it('markMissing — stamps missingSince on the given uispDeviceIds', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd1', networkSiteId: null, name: 'A', mac: null });
    const since = new Date('2026-07-15T00:00:00Z');
    await repo.markMissing(['d1'], since);
    const ap = (await repo.findMany()).find(a => a.uispDeviceId === 'd1');
    expect(ap?.missingSince).toEqual(since);
  });

  it('markMissing — does NOT re-stamp an already-missing AP (preserves original since)', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd1', networkSiteId: null, name: 'A', mac: null });
    const first = new Date('2026-07-01T00:00:00Z');
    const second = new Date('2026-07-15T00:00:00Z');
    await repo.markMissing(['d1'], first);
    await repo.markMissing(['d1'], second);
    const ap = (await repo.findMany()).find(a => a.uispDeviceId === 'd1');
    expect(ap?.missingSince).toEqual(first);
  });

  it('clearMissing — resets missingSince to null', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'd1', networkSiteId: null, name: 'A', mac: null });
    await repo.markMissing(['d1'], new Date('2026-07-15T00:00:00Z'));
    await repo.clearMissing(['d1']);
    const ap = (await repo.findMany()).find(a => a.uispDeviceId === 'd1');
    expect(ap?.missingSince).toBeNull();
  });
});
