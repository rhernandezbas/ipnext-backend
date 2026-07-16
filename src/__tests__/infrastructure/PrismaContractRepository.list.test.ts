/**
 * PrismaContractRepository.list() — contract-network-read.
 *
 * Pins two things (adapter-level, mocked Prisma client — mirrors the pattern in
 * PrismaNetworkSiteRepository.test.ts):
 *   1. Anti-N+1: the SAME findMany call includes both `networkSite` and `accessPoint`
 *      relations (projected to `{ select: { name: true } }`) — no per-contract query.
 *   2. Mapping: networkSiteId/networkSiteName/accessPointId/accessPointName are derived
 *      from the joined relations, null/null when the contract has no assignment.
 */

// Mock the prisma singleton before importing the repository
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    contract: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaContractRepository } from '../../infrastructure/adapters/prisma/PrismaContractRepository';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contract-1',
    grContratoId: null,
    clientId: 'client-1',
    client: { name: 'Juan Pérez' },
    plan: '300MB',
    status: 'active',
    technology: null,
    startDate: new Date('2024-01-15T10:00:00.000Z'),
    networkSite: null,
    accessPoint: null,
    ...overrides,
  };
}

describe('PrismaContractRepository.list() — network assignment join', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('anti-N+1: findMany is called ONCE with networkSite + accessPoint included alongside client', async () => {
    (mockPrisma.contract.findMany as jest.Mock).mockResolvedValue([makeRow()]);
    (mockPrisma.contract.count as jest.Mock).mockResolvedValue(1);

    const repo = new PrismaContractRepository();
    await repo.list({ page: 1, limit: 25 });

    expect(mockPrisma.contract.findMany).toHaveBeenCalledTimes(1);
    const callArg = (mockPrisma.contract.findMany as jest.Mock).mock.calls[0][0];
    expect(callArg.include).toMatchObject({
      client: { select: { name: true } },
      networkSite: { select: { name: true } },
      accessPoint: { select: { name: true } },
    });
  });

  it('maps null networkSite/accessPoint relations to null id + null name', async () => {
    (mockPrisma.contract.findMany as jest.Mock).mockResolvedValue([
      makeRow({ networkSiteId: null, networkSite: null, accessPointId: null, accessPoint: null }),
    ]);
    (mockPrisma.contract.count as jest.Mock).mockResolvedValue(1);

    const repo = new PrismaContractRepository();
    const result = await repo.list({ page: 1, limit: 25 });

    expect(result.data[0]?.networkSiteId).toBeNull();
    expect(result.data[0]?.networkSiteName).toBeNull();
    expect(result.data[0]?.accessPointId).toBeNull();
    expect(result.data[0]?.accessPointName).toBeNull();
  });

  it('maps a populated networkSite/accessPoint relation to id + joined name — triangulation', async () => {
    (mockPrisma.contract.findMany as jest.Mock).mockResolvedValue([
      makeRow({
        networkSiteId: 'ns-1',
        networkSite: { name: 'Nodo Centro' },
        accessPointId: 'ap-1',
        accessPoint: { name: 'AP Torre Norte' },
      }),
    ]);
    (mockPrisma.contract.count as jest.Mock).mockResolvedValue(1);

    const repo = new PrismaContractRepository();
    const result = await repo.list({ page: 1, limit: 25 });

    expect(result.data[0]?.networkSiteId).toBe('ns-1');
    expect(result.data[0]?.networkSiteName).toBe('Nodo Centro');
    expect(result.data[0]?.accessPointId).toBe('ap-1');
    expect(result.data[0]?.accessPointName).toBe('AP Torre Norte');
  });
});
