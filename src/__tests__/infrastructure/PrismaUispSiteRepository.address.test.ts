/**
 * PrismaUispSiteRepository — address field data-block tests.
 *
 * Pins that the address field travels in both the create AND update/upsert
 * data blocks. This is the only test that catches the "explicit data block
 * missing a new column" bug described in the LECCIÓN RECIENTE (uispSiteId
 * was silently dropped causing infinite re-creation of NetworkSites).
 *
 * Strategy: mock the prisma singleton so no real DB is needed.
 */
import type { UispSite } from '../../domain/entities/uisp';

// We import the module after setting up the mock so prisma is intercepted.
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    uispSite: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaUispSiteRepository } from '../../infrastructure/adapters/prisma/PrismaUispSiteRepository';

const mockUpsert = prisma.uispSite.upsert as jest.Mock;

const now = new Date('2026-06-10T00:00:00Z');

function makeSite(overrides: Partial<UispSite> = {}): UispSite {
  return {
    id: 'internal-id',
    uispId: 'uisp-uuid-1',
    name: 'Nodo Test',
    status: 'active',
    parentUispId: null,
    latitude: -34.5,
    longitude: -58.4,
    deviceCount: 5,
    outageCount: 0,
    contact: null,
    address: 'Av. Corrientes 1234',
    missingSince: null,
    lastSyncAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('PrismaUispSiteRepository — address in data blocks', () => {
  beforeEach(() => {
    mockUpsert.mockClear();
  });

  it('address is present in the create data block on upsert', async () => {
    const repo = new PrismaUispSiteRepository();
    await repo.upsert(makeSite({ address: 'Av. Corrientes 1234' }));

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const call = mockUpsert.mock.calls[0][0];
    expect(call.create.address).toBe('Av. Corrientes 1234');
  });

  it('address is present in the update data block on upsert', async () => {
    const repo = new PrismaUispSiteRepository();
    await repo.upsert(makeSite({ address: 'Calle Falsa 123' }));

    const call = mockUpsert.mock.calls[0][0];
    expect(call.update.address).toBe('Calle Falsa 123');
  });

  it('null address is passed through in both create and update', async () => {
    const repo = new PrismaUispSiteRepository();
    await repo.upsert(makeSite({ address: null }));

    const call = mockUpsert.mock.calls[0][0];
    expect(call.create.address).toBeNull();
    expect(call.update.address).toBeNull();
  });
});
