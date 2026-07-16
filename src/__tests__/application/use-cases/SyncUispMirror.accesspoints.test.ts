/**
 * SyncUispMirror — auto-import AccessPoints tests (step 9).
 *
 * Contract:
 *   - Only UispDevices with role === 'ap' become AccessPoints (station/router ignored).
 *   - Each AP links to the NetworkSite whose uispSiteId === device.uispSiteId.
 *   - AP device with no matching NetworkSite → AccessPoint with networkSiteId = null.
 *   - Idempotent: a second sync does not duplicate APs (upsert by uispDeviceId).
 *   - Empty UISP device list → APs are NOT deleted (never auto-delete discipline).
 *   - result.accessPointsCreated / accessPointsUpdated counters reported.
 *   - Optional dep: no accessPointRepo → no crash, counters 0.
 */
import { SyncUispMirror } from '../../../application/use-cases/SyncUispMirror';
import { InMemoryUispClient } from '../../../infrastructure/adapters/in-memory/InMemoryUispClient';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemorySyncStateRepository } from '../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryNetworkSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryAccessPointRepository } from '../../../infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
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
    uptime: null, lastSeenAt: null, missingSince: null, apUispDeviceId: null, lastSyncAt: now, createdAt: now,
    updatedAt: now, ...overrides,
  };
}

function build(sites: UispSite[], devices: UispDevice[]) {
  const client = new InMemoryUispClient(sites, devices);
  const siteRepo = new InMemoryUispSiteRepository();
  const deviceRepo = new InMemoryUispDeviceRepository();
  const syncStateRepo = new InMemorySyncStateRepository();
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([]); // start empty so step 8 creates fresh NetworkSites
  const accessPointRepo = new InMemoryAccessPointRepository();
  const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo, networkSiteRepo, accessPointRepo);
  return { useCase, client, networkSiteRepo, accessPointRepo };
}

describe('SyncUispMirror — auto-import AccessPoints (step 9)', () => {
  it('creates AccessPoints ONLY for devices with role="ap"', async () => {
    const sites = [makeSite('site-a')];
    const devices = [
      makeDevice('ap-1', 'site-a', 'ap'),
      makeDevice('sta-1', 'site-a', 'station'),
      makeDevice('rtr-1', 'site-a', 'router'),
      makeDevice('nul-1', 'site-a', null),
    ];
    const { useCase, accessPointRepo } = build(sites, devices);
    await useCase.execute();
    const all = await accessPointRepo.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].uispDeviceId).toBe('ap-1');
  });

  it('links each AP to the NetworkSite whose uispSiteId matches device.uispSiteId', async () => {
    const sites = [makeSite('site-a'), makeSite('site-b')];
    const devices = [
      makeDevice('ap-1', 'site-a', 'ap'),
      makeDevice('ap-2', 'site-b', 'ap'),
    ];
    const { useCase, networkSiteRepo, accessPointRepo } = build(sites, devices);
    await useCase.execute();

    const nsA = await networkSiteRepo.findByUispSiteId('site-a');
    const nsB = await networkSiteRepo.findByUispSiteId('site-b');
    const ap1 = (await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-1');
    const ap2 = (await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-2');
    expect(ap1?.networkSiteId).toBe(nsA?.id);
    expect(ap2?.networkSiteId).toBe(nsB?.id);
  });

  it('AP device with no matching NetworkSite → networkSiteId null', async () => {
    // Device points at a site that is NOT in the UISP sites list → no NetworkSite created for it.
    const sites = [makeSite('site-a')];
    const devices = [makeDevice('ap-orphan', 'site-unknown', 'ap')];
    const { useCase, accessPointRepo } = build(sites, devices);
    await useCase.execute();
    const ap = (await accessPointRepo.findMany()).find(a => a.uispDeviceId === 'ap-orphan');
    expect(ap).toBeDefined();
    expect(ap?.networkSiteId).toBeNull();
  });

  it('carries name + mac from the device onto the AccessPoint', async () => {
    const sites = [makeSite('site-a')];
    const devices = [makeDevice('ap-1', 'site-a', 'ap', { name: 'AP Torre', mac: 'AA:BB:CC:00:11:22' })];
    const { useCase, accessPointRepo } = build(sites, devices);
    await useCase.execute();
    const ap = (await accessPointRepo.findMany())[0];
    expect(ap.name).toBe('AP Torre');
    expect(ap.mac).toBe('AA:BB:CC:00:11:22');
  });

  it('idempotent — a second sync does not duplicate APs', async () => {
    const sites = [makeSite('site-a')];
    const devices = [makeDevice('ap-1', 'site-a', 'ap'), makeDevice('ap-2', 'site-a', 'ap')];
    const { useCase, accessPointRepo } = build(sites, devices);
    await useCase.execute();
    await useCase.execute();
    expect(await accessPointRepo.findMany()).toHaveLength(2);
  });

  it('reports accessPointsCreated on first run, accessPointsUpdated on re-run', async () => {
    const sites = [makeSite('site-a')];
    const devices = [makeDevice('ap-1', 'site-a', 'ap'), makeDevice('ap-2', 'site-a', 'ap')];
    const { useCase } = build(sites, devices);
    const first = await useCase.execute();
    expect(first.accessPointsCreated).toBe(2);
    expect(first.accessPointsUpdated).toBe(0);
    const second = await useCase.execute();
    expect(second.accessPointsCreated).toBe(0);
    expect(second.accessPointsUpdated).toBe(2);
  });

  it('empty UISP device list does NOT delete existing APs', async () => {
    const sites = [makeSite('site-a')];
    const devices = [makeDevice('ap-1', 'site-a', 'ap')];
    const { useCase, client, accessPointRepo } = build(sites, devices);
    await useCase.execute();
    expect(await accessPointRepo.findMany()).toHaveLength(1);

    // UISP now returns zero devices (possible truncated response) — APs must survive.
    client.setDevices([]);
    await useCase.execute();
    expect(await accessPointRepo.findMany()).toHaveLength(1);
  });

  it('re-links an AP when its device moves to another site', async () => {
    const sites = [makeSite('site-a'), makeSite('site-b')];
    const { useCase, client, networkSiteRepo, accessPointRepo } = build(sites, [makeDevice('ap-1', 'site-a', 'ap')]);
    await useCase.execute();
    const nsA = await networkSiteRepo.findByUispSiteId('site-a');
    expect((await accessPointRepo.findMany())[0].networkSiteId).toBe(nsA?.id);

    // Device relocated to site-b
    client.setDevices([makeDevice('ap-1', 'site-b', 'ap')]);
    await useCase.execute();
    const nsB = await networkSiteRepo.findByUispSiteId('site-b');
    const ap = (await accessPointRepo.findMany())[0];
    expect(ap.networkSiteId).toBe(nsB?.id);
    expect(await accessPointRepo.findMany()).toHaveLength(1); // still one row
  });

  it('works without accessPointRepo (optional dep) — no crash, counters 0', async () => {
    const client = new InMemoryUispClient([makeSite('site-a')], [makeDevice('ap-1', 'site-a', 'ap')]);
    const siteRepo = new InMemoryUispSiteRepository();
    const deviceRepo = new InMemoryUispDeviceRepository();
    const syncStateRepo = new InMemorySyncStateRepository();
    const networkSiteRepo = new InMemoryNetworkSiteRepository();
    networkSiteRepo.seedSites([]);
    const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo, networkSiteRepo);
    const result = await useCase.execute();
    expect(result.accessPointsCreated).toBe(0);
    expect(result.accessPointsUpdated).toBe(0);
  });
});
