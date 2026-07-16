/**
 * SyncUispMirror — unit tests covering SCEN-MIR-01..08.
 * All dependencies are in-memory — no DB, no live UISP calls.
 */
import { SyncUispMirror } from '../../../application/use-cases/SyncUispMirror';
import { InMemoryUispClient } from '../../../infrastructure/adapters/in-memory/InMemoryUispClient';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemorySyncStateRepository } from '../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { UispUnavailableError } from '../../../domain/errors/uisp';
import type { UispSite, UispDevice } from '../../../domain/entities/uisp';

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(uispId: string, overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: '',
    uispId,
    name: `Site ${uispId}`,
    status: 'unknown',
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

function makeDevice(uispId: string, uispSiteId: string, overrides: Partial<UispDevice> = {}): UispDevice {
  return {
    id: '',
    uispId,
    uispSiteId,
    name: `Device ${uispId}`,
    model: 'LBE-5AC-Gen2',
    modelName: null,
    type: 'airMax',
    role: 'station',
    mac: null,
    ip: '100.64.1.1',
    firmware: null,
    status: 'active',
    signal: -65,
    uptime: BigInt(12345),
    lastSeenAt: now,
    missingSince: null,
    apUispDeviceId: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildUseCase(sites: UispSite[], devices: UispDevice[]) {
  const client = new InMemoryUispClient(sites, devices);
  const siteRepo = new InMemoryUispSiteRepository();
  const deviceRepo = new InMemoryUispDeviceRepository();
  const syncStateRepo = new InMemorySyncStateRepository();
  const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo);
  return { useCase, client, siteRepo, deviceRepo, syncStateRepo };
}

describe('SyncUispMirror', () => {
  // SCEN-MIR-01: new site created
  it('SCEN-MIR-01: upserts a new site into the mirror', async () => {
    const { useCase, siteRepo } = buildUseCase([makeSite('site-1')], []);
    await useCase.execute();
    const site = await siteRepo.findByUispId('site-1');
    expect(site).not.toBeNull();
    expect(site?.name).toBe('Site site-1');
  });

  // SCEN-MIR-02: existing site updated
  it('SCEN-MIR-02: updates existing site on subsequent sync', async () => {
    const { useCase, siteRepo, client } = buildUseCase([makeSite('site-1')], []);
    await useCase.execute();

    client.setSites([makeSite('site-1', { name: 'Updated Site' })]);
    await useCase.execute();

    const site = await siteRepo.findByUispId('site-1');
    expect(site?.name).toBe('Updated Site');
    expect((await siteRepo.listAll()).length).toBe(1); // no duplicate
  });

  // SCEN-MIR-03: idempotent — no duplicate on repeated sync
  it('SCEN-MIR-03: idempotent — two identical syncs yield one row', async () => {
    const { useCase, siteRepo } = buildUseCase([makeSite('site-1')], []);
    await useCase.execute();
    await useCase.execute();
    expect((await siteRepo.listAll()).length).toBe(1);
  });

  // SCEN-MIR-04: device upserted with correct uispSiteId
  it('SCEN-MIR-04: upserts device with the correct uispSiteId', async () => {
    const { useCase, deviceRepo } = buildUseCase(
      [makeSite('site-1')],
      [makeDevice('dev-1', 'site-1')],
    );
    await useCase.execute();
    const device = await deviceRepo.findByUispId('dev-1');
    expect(device).not.toBeNull();
    expect(device?.uispSiteId).toBe('site-1');
  });

  // SCEN-MIR-05: device changes site
  it('SCEN-MIR-05: device can move to a different site', async () => {
    const { useCase, deviceRepo, client } = buildUseCase(
      [makeSite('site-1'), makeSite('site-2')],
      [makeDevice('dev-1', 'site-1')],
    );
    await useCase.execute();

    client.setDevices([makeDevice('dev-1', 'site-2')]);
    await useCase.execute();

    const device = await deviceRepo.findByUispId('dev-1');
    expect(device?.uispSiteId).toBe('site-2');
  });

  // SCEN-MIR-06: site missingSince set when site vanishes
  it('SCEN-MIR-06: sets missingSince on site that disappears from UISP', async () => {
    const { useCase, siteRepo, client } = buildUseCase([makeSite('site-1'), makeSite('site-2')], []);
    await useCase.execute();

    // site-2 disappears
    client.setSites([makeSite('site-1')]);
    await useCase.execute();

    const s2 = await siteRepo.findByUispId('site-2');
    expect(s2?.missingSince).not.toBeNull();
    const s1 = await siteRepo.findByUispId('site-1');
    expect(s1?.missingSince).toBeNull();
  });

  // SCEN-MIR-07: site missingSince cleared when site reappears
  // NOTE: FIX-3 guard means empty list = skip missing phase. Use 2-site scenario
  // so the non-empty response triggers marking site-1 as missing, then clears on reappear.
  it('SCEN-MIR-07: clears missingSince when site reappears (non-empty partial response)', async () => {
    const { useCase, siteRepo, client } = buildUseCase([makeSite('site-1'), makeSite('site-2')], []);
    await useCase.execute();

    // site-1 disappears but site-2 still present (non-empty → missing phase runs)
    client.setSites([makeSite('site-2')]);
    await useCase.execute();
    const missing = await siteRepo.findByUispId('site-1');
    expect(missing?.missingSince).not.toBeNull();

    // site-1 reappears
    client.setSites([makeSite('site-1'), makeSite('site-2')]);
    await useCase.execute();
    const cleared = await siteRepo.findByUispId('site-1');
    expect(cleared?.missingSince).toBeNull();
  });

  // SCEN-MIR-08: device missingSince set when device vanishes
  it('SCEN-MIR-08: sets missingSince on device that disappears from UISP', async () => {
    const { useCase, deviceRepo, client } = buildUseCase(
      [makeSite('site-1')],
      [makeDevice('dev-1', 'site-1'), makeDevice('dev-2', 'site-1')],
    );
    await useCase.execute();

    client.setDevices([makeDevice('dev-1', 'site-1')]);
    await useCase.execute();

    const d2 = await deviceRepo.findByUispId('dev-2');
    expect(d2?.missingSince).not.toBeNull();
  });

  // SyncState persisted
  it('persists SyncState with entity=uisp-mirror after sync', async () => {
    const { useCase, syncStateRepo } = buildUseCase([makeSite('s1')], [makeDevice('d1', 's1')]);
    await useCase.execute();
    const state = await syncStateRepo.get('uisp-mirror');
    expect(state).not.toBeNull();
    expect(state?.entity).toBe('uisp-mirror');
    expect(state?.lastRunAt).not.toBeNull();
    expect(state?.lastResult).toMatch(/ok/i);
    expect(state?.itemsSynced).toBe(2); // 1 site + 1 device
  });

  // FIX-6d: device whose site has disappeared from both UISP AND stored sites → missingSince set
  it('FIX-6d: device orphaned (site gone) → missingSince set', async () => {
    const client = new InMemoryUispClient([makeSite('site-1')], [makeDevice('dev-orphan', 'site-x')]);
    const siteRepo = new InMemoryUispSiteRepository();
    const deviceRepo = new InMemoryUispDeviceRepository();
    const syncStateRepo = new InMemorySyncStateRepository();

    // Pre-seed the orphaned device directly (simulates device that was in mirror for a site now gone)
    deviceRepo.seed(makeDevice('dev-orphan', 'site-x', { missingSince: null }));

    const useCase = new SyncUispMirror(client, siteRepo, deviceRepo, syncStateRepo);
    // UISP returns site-1 only, dev-orphan is NOT in the UISP devices response
    const clientNoOrphan = new InMemoryUispClient([makeSite('site-1')], [makeDevice('dev-1', 'site-1')]);
    const useCase2 = new SyncUispMirror(clientNoOrphan, siteRepo, deviceRepo, syncStateRepo);
    await useCase2.execute();

    const orphan = await deviceRepo.findByUispId('dev-orphan');
    expect(orphan?.missingSince).not.toBeNull();
  });

  // FIX-3: empty sites response → missing-marking skipped, existing mirror unchanged
  it('FIX-3: empty sites list → missingSince NOT set on existing sites (partial list guard)', async () => {
    const { useCase, siteRepo, client } = buildUseCase(
      [makeSite('site-1'), makeSite('site-2')],
      [],
    );
    await useCase.execute(); // populate mirror

    // Now UISP returns zero sites (truncated / proxy hiccup)
    client.setSites([]);
    await useCase.execute();

    // Both sites should still have missingSince=null — guard skipped missing phase
    const s1 = await siteRepo.findByUispId('site-1');
    const s2 = await siteRepo.findByUispId('site-2');
    expect(s1?.missingSince).toBeNull();
    expect(s2?.missingSince).toBeNull();
  });

  // FIX-3: empty devices response → missing-marking skipped for devices
  it('FIX-3: empty devices list → missingSince NOT set on existing devices (partial list guard)', async () => {
    const { useCase, deviceRepo, client } = buildUseCase(
      [makeSite('site-1')],
      [makeDevice('dev-1', 'site-1'), makeDevice('dev-2', 'site-1')],
    );
    await useCase.execute(); // populate mirror

    // UISP returns zero devices
    client.setDevices([]);
    await useCase.execute();

    const d1 = await deviceRepo.findByUispId('dev-1');
    const d2 = await deviceRepo.findByUispId('dev-2');
    expect(d1?.missingSince).toBeNull();
    expect(d2?.missingSince).toBeNull();
  });

  // UISP down — mirror intact
  it('throws UispUnavailableError when UISP is down, mirror unchanged', async () => {
    const { useCase, siteRepo, client } = buildUseCase([makeSite('site-1')], []);
    await useCase.execute(); // populate mirror

    // Make UISP fail
    client.setSites(null as never); // will throw in listSites
    jest.spyOn(client, 'listSites').mockRejectedValueOnce(new UispUnavailableError('UISP down'));

    await expect(useCase.execute()).rejects.toThrow(UispUnavailableError);

    // Mirror still has the original site
    const s1 = await siteRepo.findByUispId('site-1');
    expect(s1).not.toBeNull();
  });
});
