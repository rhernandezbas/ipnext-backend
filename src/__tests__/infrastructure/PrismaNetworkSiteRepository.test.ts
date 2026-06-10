/**
 * PrismaNetworkSiteRepository — adapter unit tests with mocked Prisma client.
 *
 * Purpose: pin that create() and update() pass uispSiteId to Prisma.
 * This is the bug the in-memory can NOT catch: InMemoryNetworkSiteRepository
 * spreads the whole data object, so uispSiteId is always persisted there.
 * The Prisma adapter has an EXPLICIT data block — omitting a field == silent null.
 *
 * Pattern mirrors PrismaUispSiteRepository.test.ts (jest.mock at module level).
 */

// Mock the prisma singleton before importing the repository
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    networkSite: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaNetworkSiteRepository } from '../../infrastructure/adapters/prisma/PrismaNetworkSiteRepository';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ns-1',
    name: 'Site A',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PrismaNetworkSiteRepository — create() passes uispSiteId to Prisma', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('FIX-1: create() sends uispSiteId in the Prisma data block', async () => {
    const returnedRow = makeRow({ uispSiteId: 'uisp-abc' });
    (mockPrisma.networkSite.create as jest.Mock).mockResolvedValue(returnedRow);

    const repo = new PrismaNetworkSiteRepository();
    const result = await repo.create({
      name: 'Site A',
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
      uispSiteId: 'uisp-abc',
    });

    // Verify the call was made with uispSiteId in the data block
    expect(mockPrisma.networkSite.create).toHaveBeenCalledTimes(1);
    const callArg = (mockPrisma.networkSite.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data).toMatchObject({ uispSiteId: 'uisp-abc' });

    // Verify the returned entity maps uispSiteId correctly
    expect(result.uispSiteId).toBe('uisp-abc');
  });

  it('create() with uispSiteId=null sends null (not undefined)', async () => {
    const returnedRow = makeRow({ uispSiteId: null });
    (mockPrisma.networkSite.create as jest.Mock).mockResolvedValue(returnedRow);

    const repo = new PrismaNetworkSiteRepository();
    await repo.create({
      name: 'Site B',
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
    });

    const callArg = (mockPrisma.networkSite.create as jest.Mock).mock.calls[0][0];
    // uispSiteId must be present in the data block (not omitted), and be null
    expect('uispSiteId' in callArg.data).toBe(true);
    expect(callArg.data.uispSiteId).toBeNull();
  });
});
