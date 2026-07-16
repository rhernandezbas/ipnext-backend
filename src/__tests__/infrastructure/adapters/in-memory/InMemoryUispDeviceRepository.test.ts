/**
 * InMemoryUispDeviceRepository — port behavior, focused on apUispDeviceId (MIR-2).
 *
 * upsert MUST persist apUispDeviceId on create AND re-link it (overwrite) on a subsequent
 * upsert of the SAME uispId — a device that changes AP between syncs must end up with the
 * new apUispDeviceId in the SAME row (findByUispId returns exactly one row).
 */
import { InMemoryUispDeviceRepository } from '@infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import type { UispDeviceRepository } from '@domain/ports/UispDeviceRepository';
import type { UispDevice } from '@domain/entities/uisp';

function makeDevice(overrides: Partial<UispDevice> = {}): UispDevice {
  const now = new Date();
  return {
    id: '',
    uispId: 'uisp-dev-1',
    uispSiteId: 'site-1',
    name: 'Station 1',
    model: 'LiteBeam',
    modelName: null,
    type: null,
    role: 'station',
    mac: 'aabbccddeeff',
    ip: '10.0.0.5',
    firmware: null,
    status: 'active',
    signal: -55,
    uptime: null,
    lastSeenAt: null,
    missingSince: null,
    apUispDeviceId: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('InMemoryUispDeviceRepository — apUispDeviceId', () => {
  it('implements the UispDeviceRepository port', () => {
    const repo: UispDeviceRepository = new InMemoryUispDeviceRepository();
    expect(typeof repo.upsert).toBe('function');
    expect(typeof repo.findByUispId).toBe('function');
  });

  it('upsert persists apUispDeviceId on create', async () => {
    const repo = new InMemoryUispDeviceRepository();
    await repo.upsert(makeDevice({ apUispDeviceId: 'ap-1' }));
    const found = await repo.findByUispId('uisp-dev-1');
    expect(found?.apUispDeviceId).toBe('ap-1');
  });

  it('re-upserting the same uispId re-links apUispDeviceId in the SAME row', async () => {
    const repo = new InMemoryUispDeviceRepository();
    await repo.upsert(makeDevice({ apUispDeviceId: 'ap-1' }));
    await repo.upsert(makeDevice({ apUispDeviceId: 'ap-2' }));

    const all = await repo.listAll();
    expect(all).toHaveLength(1);
    const found = await repo.findByUispId('uisp-dev-1');
    expect(found?.apUispDeviceId).toBe('ap-2');
  });

  it('apUispDeviceId defaults to null when absent (station without a reported AP)', async () => {
    const repo = new InMemoryUispDeviceRepository();
    await repo.upsert(makeDevice({ apUispDeviceId: null }));
    const found = await repo.findByUispId('uisp-dev-1');
    expect(found?.apUispDeviceId).toBeNull();
  });
});
