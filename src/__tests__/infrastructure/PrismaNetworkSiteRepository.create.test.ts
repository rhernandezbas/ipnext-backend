/**
 * PrismaNetworkSiteRepository.create — data-block pin test.
 *
 * Guards against the "explicit data block missing a new column" bug:
 * when a new column is added, an explicit data block silently drops it
 * (unlike InMemory spread which picks up all fields automatically).
 *
 * Pins that uispSiteId, iclassNodeCode, and address all travel through
 * the Prisma create() data object.
 *
 * Mirrors PrismaUispSiteRepository.address.test.ts pattern.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    networkSite: {
      create: jest.fn().mockResolvedValue({
        id: 'new-id',
        siteNumber: 1,
        name: 'Test',
        address: null,
        city: null,
        lat: null,
        lng: null,
        type: 'nodo',
        status: 'active',
        deviceCount: 0,
        clientCount: 0,
        uplink: null,
        parentSiteId: null,
        description: null,
        iclassNodeCode: null,
        uispSiteId: null,
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue(null),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaNetworkSiteRepository } from '../../infrastructure/adapters/prisma/PrismaNetworkSiteRepository';
import type { NetworkSite } from '../../domain/entities/networkSite';

const mockCreate = prisma.networkSite.create as jest.Mock;

function makeData(overrides: Partial<Omit<NetworkSite, 'id' | 'siteNumber' | 'fixedCode'>> = {}): Omit<NetworkSite, 'id' | 'siteNumber' | 'fixedCode'> {
  return {
    name: 'Nodo Test',
    address: '',
    city: '',
    coordinates: null,
    type: 'nodo',
    status: 'active',
    deviceCount: 0,
    clientCount: 0,
    uplink: '',
    parentSiteId: null,
    description: '',
    iclassNodeCode: null,
    uispSiteId: null,
    ...overrides,
  };
}

describe('PrismaNetworkSiteRepository.create — data block pins', () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it('uispSiteId travels in the create data block', async () => {
    const repo = new PrismaNetworkSiteRepository();
    await repo.create(makeData({ uispSiteId: 'uisp-uuid-1' }));
    const call = mockCreate.mock.calls[0][0];
    expect(call.data.uispSiteId).toBe('uisp-uuid-1');
  });

  it('iclassNodeCode travels in the create data block', async () => {
    const repo = new PrismaNetworkSiteRepository();
    await repo.create(makeData({ iclassNodeCode: 'NC-001' }));
    const call = mockCreate.mock.calls[0][0];
    expect(call.data.iclassNodeCode).toBe('NC-001');
  });

  it('address travels in the create data block', async () => {
    const repo = new PrismaNetworkSiteRepository();
    await repo.create(makeData({ address: 'Av. Corrientes 1234' }));
    const call = mockCreate.mock.calls[0][0];
    expect(call.data.address).toBe('Av. Corrientes 1234');
  });

  it('null uispSiteId and iclassNodeCode are passed through (not omitted)', async () => {
    const repo = new PrismaNetworkSiteRepository();
    await repo.create(makeData({ uispSiteId: null, iclassNodeCode: null, address: '' }));
    const call = mockCreate.mock.calls[0][0];
    expect(call.data.uispSiteId).toBeNull();
    expect(call.data.iclassNodeCode).toBeNull();
    expect(call.data.address).toBe('');
  });
});
