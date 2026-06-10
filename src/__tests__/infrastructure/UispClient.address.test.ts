/**
 * UispClient — address field mapping tests.
 *
 * Tests that the real UispClient.mapSite correctly:
 *   1. Maps description.address to site.address (trimmed).
 *   2. Returns null when description.address is absent.
 *   3. Returns null when description.address is empty/whitespace after trim.
 *
 * Uses an injectable http option (per UispClientOptions.http) with a mock axios instance
 * to avoid real network calls. This is the only test that catches bugs where
 * description.address is silently dropped in the data block.
 */
import { UispClient } from '../../infrastructure/adapters/uisp/UispClient';
import type { AxiosInstance } from 'axios';

function makeHttpMock(sites: unknown[]): AxiosInstance {
  return {
    get: jest.fn().mockResolvedValue({ data: sites }),
  } as unknown as AxiosInstance;
}

function makeSiteRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identification: {
      id: 'uisp-uuid-1',
      name: 'Nodo Test',
      status: 'active',
      parent: null,
    },
    description: {
      deviceCount: 5,
      deviceOutageCount: 0,
      location: { latitude: -34.5, longitude: -58.4 },
      contact: null,
      ...overrides,
    },
  };
}

describe('UispClient — address mapping', () => {
  it('maps description.address to site.address (trimmed)', async () => {
    const raw = makeSiteRaw({ address: '  Av. Corrientes 1234\t' });
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const sites = await client.listSites();
    expect(sites[0].address).toBe('Av. Corrientes 1234');
  });

  it('returns null when description.address is absent', async () => {
    const raw = makeSiteRaw(); // no address key
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const sites = await client.listSites();
    expect(sites[0].address).toBeNull();
  });

  it('returns null when description.address is empty string', async () => {
    const raw = makeSiteRaw({ address: '' });
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const sites = await client.listSites();
    expect(sites[0].address).toBeNull();
  });

  it('returns null when description.address is whitespace-only', async () => {
    const raw = makeSiteRaw({ address: '   \t  ' });
    const http = makeHttpMock([raw]);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const sites = await client.listSites();
    expect(sites[0].address).toBeNull();
  });

  it('address travels through listSites when present in multiple sites', async () => {
    const raws = [
      makeSiteRaw({ address: 'Calle Falsa 123' }),
      makeSiteRaw({ address: null }),
    ];
    // Give them distinct uispIds
    (raws[1].identification as Record<string, unknown>).id = 'uisp-uuid-2';
    const http = makeHttpMock(raws);
    const client = new UispClient({ baseUrl: 'http://uisp', token: 'tok', http });
    const sites = await client.listSites();
    expect(sites[0].address).toBe('Calle Falsa 123');
    expect(sites[1].address).toBeNull();
  });
});
