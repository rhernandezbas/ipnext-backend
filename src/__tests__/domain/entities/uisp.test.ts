import {
  createUispSite,
  createUispDevice,
  type UispSite,
  type UispDevice,
} from '../../../domain/entities/uisp';

describe('UispSite entity', () => {
  const now = new Date('2026-06-10T00:00:00Z');

  it('creates a UispSite with all required fields', () => {
    const site: UispSite = createUispSite({
      id: 'uuid-1',
      uispId: 'cc4fce3f-b023-4b7e-a5e2-3d6a80536856',
      name: '[54] Nodo Municipio',
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
    });
    expect(site.uispId).toBe('cc4fce3f-b023-4b7e-a5e2-3d6a80536856');
    expect(site.name).toBe('[54] Nodo Municipio');
    expect(site.status).toBe('unknown');
    expect(site.deviceCount).toBe(0);
    expect(site.outageCount).toBe(0);
  });

  it('nullable fields default to null when not provided via factory', () => {
    const site = createUispSite({
      id: 'uuid-2',
      uispId: 'abc',
      name: 'Site',
      status: 'active',
      parentUispId: null,
      latitude: null,
      longitude: null,
      deviceCount: 5,
      outageCount: 1,
      contact: null,
      address: null,
      missingSince: null,
      lastSyncAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(site.parentUispId).toBeNull();
    expect(site.latitude).toBeNull();
    expect(site.longitude).toBeNull();
    expect(site.contact).toBeNull();
    expect(site.missingSince).toBeNull();
  });

  it('accepts non-null optional fields', () => {
    const site = createUispSite({
      id: 'uuid-3',
      uispId: 'xyz',
      name: 'Site X',
      status: 'active',
      parentUispId: 'parent-uuid',
      latitude: -34.89844,
      longitude: -60.01962,
      deviceCount: 10,
      outageCount: 2,
      contact: 'Pablo Sarto',
      address: 'Calle Falsa 123',
      missingSince: now,
      lastSyncAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(site.parentUispId).toBe('parent-uuid');
    expect(site.latitude).toBe(-34.89844);
    expect(site.longitude).toBe(-60.01962);
    expect(site.contact).toBe('Pablo Sarto');
    expect(site.missingSince).toBe(now);
  });
});

describe('UispDevice entity', () => {
  const now = new Date('2026-06-10T00:00:00Z');

  it('creates a UispDevice with all required fields', () => {
    const device: UispDevice = createUispDevice({
      id: 'dev-uuid-1',
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
    });
    expect(device.uispId).toBe('001b0248-aabb-ccdd-eeff-001234567890');
    expect(device.uispSiteId).toBe('cc4fce3f-b023-4b7e-a5e2-3d6a80536856');
    expect(device.name).toBe('LucianaDelorenzi2Ch');
    expect(device.uptime).toBe(BigInt(125351));
    expect(typeof device.uptime).toBe('bigint');
  });

  it('uptime is typed bigint | null', () => {
    const device = createUispDevice({
      id: 'dev-uuid-2',
      uispId: 'offline-dev',
      uispSiteId: 'site-uuid',
      name: 'OfflineDev',
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
    });
    expect(device.uptime).toBeNull();
    expect(device.signal).toBeNull();
  });

  it('nullable optional fields accept null', () => {
    const device = createUispDevice({
      id: 'dev-uuid-3',
      uispId: 'minimal-dev',
      uispSiteId: 'site-uuid',
      name: 'MinimalDev',
      model: 'ModelX',
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
    });
    expect(device.modelName).toBeNull();
    expect(device.type).toBeNull();
    expect(device.role).toBeNull();
    expect(device.mac).toBeNull();
    expect(device.ip).toBeNull();
    expect(device.firmware).toBeNull();
    expect(device.lastSeenAt).toBeNull();
    expect(device.missingSince).toBeNull();
  });
});
