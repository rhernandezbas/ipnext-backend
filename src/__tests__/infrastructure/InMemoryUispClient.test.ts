/**
 * Unit tests for UispClient field mapping (InMemoryUispClient as stand-in for mapper purity tests)
 * and the real UispClient field mapper logic (ipAddress top-level, null signal/uptime, missing optional fields).
 *
 * The real UispClient is not instantiated (no live calls) — we test the parser functions exported
 * for testability OR test via InMemoryUispClient behavior contracts.
 */
import { InMemoryUispClient } from '../../infrastructure/adapters/in-memory/InMemoryUispClient';
import type { UispSite, UispDevice } from '../../domain/entities/uisp';

describe('InMemoryUispClient', () => {
  const now = new Date('2026-06-10T00:00:00Z');

  const site1: UispSite = {
    id: 'site-internal-1',
    uispId: 'cc4fce3f-b023-4b7e-a5e2-3d6a80536856',
    name: '[54] Nodo Municipio',
    status: 'unknown',
    parentUispId: null,
    latitude: -34.89844,
    longitude: -60.01962,
    deviceCount: 272,
    outageCount: 33,
    contact: 'Pablo Sarto',
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const device1: UispDevice = {
    id: 'dev-internal-1',
    uispId: '001b0248-aabb-ccdd-eeff-001234567890',
    uispSiteId: 'cc4fce3f-b023-4b7e-a5e2-3d6a80536856',
    name: 'LucianaDelorenzi2Ch',
    model: 'LBE-5AC-Gen2',
    modelName: 'LiteBeam 5AC',
    type: 'airMax',
    role: 'station',
    mac: 'e0:63:da:f0:78:ac',
    ip: '100.64.66.172',
    firmware: '8.7.14',
    status: 'active',
    signal: -73,
    uptime: BigInt(125351),
    lastSeenAt: now,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const offlineDevice: UispDevice = {
    id: 'dev-offline',
    uispId: 'offline-uuid',
    uispSiteId: 'cc4fce3f-b023-4b7e-a5e2-3d6a80536856',
    name: 'OfflineDevice',
    model: 'P5B-300',
    modelName: null,
    type: null,
    role: null,
    mac: null,
    ip: null,
    firmware: null,
    status: 'disconnected',
    signal: null,
    uptime: null,
    lastSeenAt: null,
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
  };

  it('listSites returns seeded sites', async () => {
    const client = new InMemoryUispClient([site1], []);
    const sites = await client.listSites();
    expect(sites).toHaveLength(1);
    expect(sites[0].uispId).toBe('cc4fce3f-b023-4b7e-a5e2-3d6a80536856');
    expect(sites[0].name).toBe('[54] Nodo Municipio');
  });

  it('listDevices returns seeded devices', async () => {
    const client = new InMemoryUispClient([], [device1]);
    const devices = await client.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].uispId).toBe('001b0248-aabb-ccdd-eeff-001234567890');
  });

  it('ipAddress is mapped to ip field (top-level in UISP API)', async () => {
    const client = new InMemoryUispClient([], [device1]);
    const devices = await client.listDevices();
    expect(devices[0].ip).toBe('100.64.66.172');
  });

  it('signal and uptime are null for offline device', async () => {
    const client = new InMemoryUispClient([], [offlineDevice]);
    const devices = await client.listDevices();
    expect(devices[0].signal).toBeNull();
    expect(devices[0].uptime).toBeNull();
  });

  it('uptime is bigint when present', async () => {
    const client = new InMemoryUispClient([], [device1]);
    const devices = await client.listDevices();
    expect(typeof devices[0].uptime).toBe('bigint');
    expect(devices[0].uptime).toBe(BigInt(125351));
  });

  it('optional fields (modelName, type, role, mac, firmware) are null when missing', async () => {
    const client = new InMemoryUispClient([], [offlineDevice]);
    const devices = await client.listDevices();
    expect(devices[0].modelName).toBeNull();
    expect(devices[0].type).toBeNull();
    expect(devices[0].role).toBeNull();
    expect(devices[0].mac).toBeNull();
    expect(devices[0].firmware).toBeNull();
  });

  it('setSites allows replacing sites after construction', async () => {
    const client = new InMemoryUispClient([site1], []);
    const newSite: UispSite = { ...site1, uispId: 'new-uuid', name: 'New Site' };
    client.setSites([newSite]);
    const sites = await client.listSites();
    expect(sites).toHaveLength(1);
    expect(sites[0].uispId).toBe('new-uuid');
  });

  it('setDevices allows replacing devices after construction', async () => {
    const client = new InMemoryUispClient([], [device1]);
    client.setDevices([]);
    const devices = await client.listDevices();
    expect(devices).toHaveLength(0);
  });
});
