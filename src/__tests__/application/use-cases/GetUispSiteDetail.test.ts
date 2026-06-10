/**
 * GetUispSiteDetail — SCEN-API-04, SCEN-API-05.
 */
import { GetUispSiteDetail } from '../../../application/use-cases/GetUispSiteDetail';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { UispSiteNotFoundError } from '../../../domain/errors/uisp';
import type { UispSite, UispDevice } from '../../../domain/entities/uisp';

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(uispId: string): UispSite {
  return {
    id: `internal-${uispId}`,
    uispId,
    name: `Site ${uispId}`,
    status: 'unknown',
    parentUispId: null,
    latitude: -34.89844,
    longitude: -60.01962,
    deviceCount: 11,
    outageCount: 2,
    contact: 'Pablo Sarto',
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeDevice(uispId: string, uispSiteId: string): UispDevice {
  return {
    id: `dev-${uispId}`,
    uispId,
    uispSiteId,
    name: `Device ${uispId}`,
    model: 'LBE-5AC-Gen2',
    modelName: 'LiteBeam 5AC',
    type: 'airMax',
    role: 'station',
    mac: 'aa:bb:cc:dd:ee:ff',
    ip: '100.64.1.1',
    firmware: '8.7.14',
    status: 'active',
    signal: -68,
    uptime: BigInt(125000),
    lastSeenAt: now,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe('GetUispSiteDetail', () => {
  // SCEN-API-04: site detail with devices
  it('SCEN-API-04: returns site detail + devices for a known uispId', async () => {
    const siteRepo = new InMemoryUispSiteRepository();
    const deviceRepo = new InMemoryUispDeviceRepository();
    siteRepo.seed(makeSite('site-1'));
    for (let i = 0; i < 11; i++) deviceRepo.seed(makeDevice(`dev-${i}`, 'site-1'));

    const uc = new GetUispSiteDetail(siteRepo, deviceRepo);
    const result = await uc.execute('site-1');

    expect(result.site.uispId).toBe('site-1');
    expect(result.site.latitude).toBe(-34.89844);
    expect(result.site.longitude).toBe(-60.01962);
    expect(result.site.contact).toBe('Pablo Sarto');
    expect(result.devices).toHaveLength(11);
  });

  it('SCEN-API-04: device DTO includes uptime as string | null', async () => {
    const siteRepo = new InMemoryUispSiteRepository();
    const deviceRepo = new InMemoryUispDeviceRepository();
    siteRepo.seed(makeSite('site-1'));
    deviceRepo.seed(makeDevice('dev-1', 'site-1'));

    const uc = new GetUispSiteDetail(siteRepo, deviceRepo);
    const result = await uc.execute('site-1');

    const dev = result.devices[0];
    expect(typeof dev.uptime).toBe('string');
    expect(dev.uptime).toBe('125000');
  });

  it('SCEN-API-04: null uptime maps to null in DTO', async () => {
    const siteRepo = new InMemoryUispSiteRepository();
    const deviceRepo = new InMemoryUispDeviceRepository();
    siteRepo.seed(makeSite('site-1'));
    const offlineDev: UispDevice = {
      ...makeDevice('dev-offline', 'site-1'),
      uptime: null,
      signal: null,
    };
    deviceRepo.seed(offlineDev);

    const uc = new GetUispSiteDetail(siteRepo, deviceRepo);
    const result = await uc.execute('site-1');

    expect(result.devices[0].uptime).toBeNull();
  });

  // SCEN-API-05: 404 when site not found
  it('SCEN-API-05: throws UispSiteNotFoundError for unknown uispId', async () => {
    const siteRepo = new InMemoryUispSiteRepository();
    const deviceRepo = new InMemoryUispDeviceRepository();

    const uc = new GetUispSiteDetail(siteRepo, deviceRepo);
    await expect(uc.execute('nonexistent')).rejects.toThrow(UispSiteNotFoundError);
  });
});
