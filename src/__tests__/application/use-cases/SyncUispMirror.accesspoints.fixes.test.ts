/**
 * SyncUispMirror — AP-catalog FIX WAVE tests (step 9 hardening).
 *
 * FIX-1 [HIGH]  — the AP catalog step is isolated in try/catch: a failure there (e.g. the
 *                 AccessPoint table not yet migrated) must NOT abort the sync. Sites/devices
 *                 stay persisted and the SyncState "ok" is still written.
 * FIX-2 [MED]   — retired APs: missingSince is stamped when a device vanishes / drops role='ap',
 *                 cleared when it reappears; an empty (or zero-role='ap') response does NOT mark
 *                 the whole catalog missing (anti-truncation guard, mirrors steps 4-6).
 * FIX-3 [LOW]   — role match is case-insensitive ('AP'/'Ap' still seed an AccessPoint).
 * FIX-4 [LOW]   — a uispDeviceId repeated in the response is counted once (no double-count).
 */
import { SyncUispMirror } from '../../../application/use-cases/SyncUispMirror';
import { InMemoryUispClient } from '../../../infrastructure/adapters/in-memory/InMemoryUispClient';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemorySyncStateRepository } from '../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryNetworkSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryAccessPointRepository } from '../../../infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
import type { AccessPoint } from '../../../domain/entities/accessPoint';
import type { AccessPointRepository, UpsertAccessPointInput } from '../../../domain/ports/AccessPointRepository';
import type { UispSite, UispDevice } from '../../../domain/entities/uisp';

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: '', uispId, name: `Site ${uispId}`, status: 'active', parentUispId: null,
    latitude: null, longitude: null, deviceCount: 0, outageCount: 0, contact: null,
    address: null, missingSince: null, lastSyncAt: now, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function makeDevice(uispId: string, uispSiteId: string, role: string | null, overrides: Partial<UispDevice> = {}): UispDevice {
  return {
    id: '', uispId, uispSiteId, name: `Device ${uispId}`, model: 'M', modelName: null,
    type: null, role, mac: null, ip: null, firmware: null, status: 'active', signal: null,
    uptime: null, lastSeenAt: null, missingSince: null, lastSyncAt: now, createdAt: now,
    updatedAt: now, ...overrides,
  };
}

function build(sites: UispSite[], devices: UispDevice[], apRepo?: AccessPointRepository) {
  const client = new InMemoryUispClient(sites, devices);
  const siteRepo = new InMemoryUispSiteRepository();
  const deviceRepo = new InMemoryUispDeviceRepository();
  const syncStateRepo = new InMemorySyncStateRepository();
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([]);
  const accessPointRepo = apRepo ?? new InMemoryAccessPointRepository();
  const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo, networkSiteRepo, accessPointRepo);
  return { useCase, client, siteRepo, deviceRepo, syncStateRepo, networkSiteRepo, accessPointRepo };
}

/** FIX-1 seam: an AP repo whose reads/writes always throw (simulates the missing table). */
class ThrowingAccessPointRepository implements AccessPointRepository {
  async upsertByUispDeviceId(_input: UpsertAccessPointInput): Promise<AccessPoint> {
    throw new Error('AccessPoint table does not exist');
  }
  async findMany(): Promise<AccessPoint[]> {
    throw new Error('AccessPoint table does not exist');
  }
  async findByNetworkSiteId(_networkSiteId: string): Promise<AccessPoint[]> {
    throw new Error('AccessPoint table does not exist');
  }
  async findById(_id: string): Promise<AccessPoint | null> {
    throw new Error('AccessPoint table does not exist');
  }
  async markMissing(_ids: string[], _since: Date): Promise<void> {
    throw new Error('AccessPoint table does not exist');
  }
  async clearMissing(_ids: string[]): Promise<void> {
    throw new Error('AccessPoint table does not exist');
  }
}

describe('SyncUispMirror — FIX-1: AP catalog step is isolated (degrades softly)', () => {
  it('a throwing accessPointRepo does NOT abort the sync; sites/devices persist + SyncState "ok"', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const sites = [makeSite('site-a'), makeSite('site-b')];
    const devices = [makeDevice('ap-1', 'site-a', 'ap'), makeDevice('rtr-1', 'site-b', 'router')];
    const { useCase, siteRepo, deviceRepo, syncStateRepo } = build(sites, devices, new ThrowingAccessPointRepository());

    // Must not re-throw — the catalog failure is swallowed.
    const result = await useCase.execute();

    // sites + devices persisted despite the AP step blowing up
    expect((await siteRepo.listAll())).toHaveLength(2);
    expect((await deviceRepo.listAll())).toHaveLength(2);
    expect(result.sitesUpserted).toBe(2);
    expect(result.devicesUpserted).toBe(2);

    // AP counters degrade to 0
    expect(result.accessPointsCreated).toBe(0);
    expect(result.accessPointsUpdated).toBe(0);

    // SyncState reports "ok" (not error) so the scheduler doesn't mask a healthy sync
    const state = await syncStateRepo.get('uisp-mirror');
    expect(state?.lastResult?.startsWith('ok:')).toBe(true);
    expect(state?.itemsSynced).toBe(4); // 2 sites + 2 devices

    expect(warnSpy).toHaveBeenCalledWith('[uisp-sync] AP catalog step failed:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('SyncUispMirror — FIX-2: retired-AP marking (missingSince)', () => {
  it('stamps missingSince when a device vanishes (other AP devices still present → guard passes)', async () => {
    const sites = [makeSite('site-a')];
    const { useCase, client, accessPointRepo } = build(sites, [
      makeDevice('ap-1', 'site-a', 'ap'),
      makeDevice('ap-2', 'site-a', 'ap'),
    ]);
    await useCase.execute();
    expect((await accessPointRepo.findMany()).every(a => a.missingSince === null)).toBe(true);

    // ap-1 disappears; ap-2 still present (guard passes)
    client.setDevices([makeDevice('ap-2', 'site-a', 'ap')]);
    await useCase.execute();

    const all = await accessPointRepo.findMany();
    const ap1 = all.find(a => a.uispDeviceId === 'ap-1');
    const ap2 = all.find(a => a.uispDeviceId === 'ap-2');
    expect(ap1?.missingSince).toBeInstanceOf(Date);
    expect(ap2?.missingSince).toBeNull();
    // never physically deleted — catalog keeps both rows
    expect(all).toHaveLength(2);
  });

  it('stamps missingSince when a device drops its role away from "ap"', async () => {
    const sites = [makeSite('site-a')];
    const { useCase, client, accessPointRepo } = build(sites, [
      makeDevice('ap-1', 'site-a', 'ap'),
      makeDevice('ap-2', 'site-a', 'ap'),
    ]);
    await useCase.execute();

    // ap-1 is no longer an AP (became a station); ap-2 still an AP
    client.setDevices([
      makeDevice('ap-1', 'site-a', 'station'),
      makeDevice('ap-2', 'site-a', 'ap'),
    ]);
    await useCase.execute();

    const ap1 = (await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-1');
    expect(ap1?.missingSince).toBeInstanceOf(Date);
  });

  it('clears missingSince when the AP reappears', async () => {
    const sites = [makeSite('site-a')];
    const { useCase, client, accessPointRepo } = build(sites, [
      makeDevice('ap-1', 'site-a', 'ap'),
      makeDevice('ap-2', 'site-a', 'ap'),
    ]);
    await useCase.execute();
    client.setDevices([makeDevice('ap-2', 'site-a', 'ap')]); // ap-1 gone → marked missing
    await useCase.execute();
    expect((await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-1')?.missingSince).toBeInstanceOf(Date);

    // ap-1 back
    client.setDevices([makeDevice('ap-1', 'site-a', 'ap'), makeDevice('ap-2', 'site-a', 'ap')]);
    await useCase.execute();
    expect((await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-1')?.missingSince).toBeNull();
  });

  it('GUARD: an empty device list does NOT mark the catalog missing (anti-truncation)', async () => {
    const sites = [makeSite('site-a')];
    const { useCase, client, accessPointRepo } = build(sites, [makeDevice('ap-1', 'site-a', 'ap')]);
    await useCase.execute();

    // UISP returns zero devices (possible truncation) — must NOT mark ap-1 missing
    client.setDevices([]);
    await useCase.execute();
    expect((await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-1')?.missingSince).toBeNull();
  });

  it('GUARD: a response with devices but ZERO role="ap" does NOT mark the catalog missing', async () => {
    const sites = [makeSite('site-a')];
    const { useCase, client, accessPointRepo } = build(sites, [makeDevice('ap-1', 'site-a', 'ap')]);
    await useCase.execute();

    // devices present but none are APs anymore
    client.setDevices([makeDevice('rtr-1', 'site-a', 'router')]);
    await useCase.execute();
    expect((await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-1')?.missingSince).toBeNull();
  });
});

describe('SyncUispMirror — FIX-3: role match is case-insensitive', () => {
  it('seeds an AccessPoint for role "AP" (uppercase) and "Ap" (mixed)', async () => {
    const sites = [makeSite('site-a')];
    const devices = [
      makeDevice('ap-upper', 'site-a', 'AP'),
      makeDevice('ap-mixed', 'site-a', 'Ap'),
      makeDevice('sta-1', 'site-a', 'STATION'),
    ];
    const { useCase, accessPointRepo } = build(sites, devices);
    await useCase.execute();
    const ids = (await accessPointRepo.findMany()).map(a => a.uispDeviceId).sort();
    expect(ids).toEqual(['ap-mixed', 'ap-upper']);
  });
});

describe('SyncUispMirror — FIX-4: duplicate uispDeviceId counted once', () => {
  it('a uispDeviceId repeated in the same response is counted as ONE created', async () => {
    const sites = [makeSite('site-a')];
    const devices = [
      makeDevice('ap-dup', 'site-a', 'ap'),
      makeDevice('ap-dup', 'site-a', 'ap'), // same id twice
    ];
    const { useCase, accessPointRepo } = build(sites, devices);
    const result = await useCase.execute();
    expect(result.accessPointsCreated).toBe(1);
    expect(result.accessPointsUpdated).toBe(0);
    expect(await accessPointRepo.findMany()).toHaveLength(1);
  });
});
