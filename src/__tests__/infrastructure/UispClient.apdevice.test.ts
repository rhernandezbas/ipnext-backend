/**
 * UispClient — apUispDeviceId (station→AP link) mapping tests.
 *
 * contract-node-ap-auto-assign (Fase B, MIR-1): `mapDevice` MUST extract
 * `raw.attributes.apDevice.id` → `UispDevice.apUispDeviceId`, null-safe (no throw) when
 * `attributes`, `apDevice` or `id` are absent.
 *
 * Uses an injectable http option (per UispClientOptions.http) with a mock axios instance
 * to avoid real network calls — same pattern as UispClient.address.test.ts.
 */
import { UispClient } from '../../infrastructure/adapters/uisp/UispClient';
import type { AxiosInstance } from 'axios';

function makeHttpMock(devices: unknown[]): AxiosInstance {
  return {
    get: jest.fn().mockResolvedValue({ data: devices }),
  } as unknown as AxiosInstance;
}

function makeDeviceRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identification: {
      id: 'uisp-device-uuid-1',
      name: 'Station Test',
      model: 'LiteBeam',
      modelName: 'LiteBeam AC',
      type: 'airMax',
      role: 'station',
      mac: 'AA:BB:CC:DD:EE:FF',
      firmwareVersion: '8.7.11',
      site: { id: 'site-uuid-1' },
    },
    overview: {
      status: 'active',
      signal: -55,
      uptime: 12345,
      lastSeen: '2026-07-16T12:00:00.000Z',
    },
    ipAddress: '10.0.0.5',
    ...overrides,
  };
}

describe('UispClient — apUispDeviceId mapping', () => {
  it('maps attributes.apDevice.id to apUispDeviceId', async () => {
    const raw = makeDeviceRaw({
      attributes: { ssid: 'Hornet9_Canepa', apDevice: { id: 'ap-uuid-1', type: 'airMax' } },
    });
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const devices = await client.listDevices();
    expect(devices[0].apUispDeviceId).toBe('ap-uuid-1');
  });

  it('returns null when attributes is absent (no throw)', async () => {
    const raw = makeDeviceRaw(); // no `attributes` key at all
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const devices = await client.listDevices();
    expect(devices[0].apUispDeviceId).toBeNull();
  });

  it('returns null when attributes.apDevice is absent (no throw)', async () => {
    const raw = makeDeviceRaw({ attributes: { ssid: 'Hornet9_Canepa' } });
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const devices = await client.listDevices();
    expect(devices[0].apUispDeviceId).toBeNull();
  });

  it('returns null when attributes.apDevice.id is absent (no throw)', async () => {
    const raw = makeDeviceRaw({ attributes: { apDevice: { type: 'airMax' } } });
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const devices = await client.listDevices();
    expect(devices[0].apUispDeviceId).toBeNull();
  });

  it('an AP device itself (no apDevice attribute) maps to null, not throw', async () => {
    const raw = makeDeviceRaw({ identification: { id: 'ap-uuid-1', name: 'AP Test', model: 'RP-5AC', role: 'ap', site: { id: 'site-uuid-1' } } });
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const devices = await client.listDevices();
    expect(devices[0].apUispDeviceId).toBeNull();
    expect(devices[0].role).toBe('ap');
  });
});
