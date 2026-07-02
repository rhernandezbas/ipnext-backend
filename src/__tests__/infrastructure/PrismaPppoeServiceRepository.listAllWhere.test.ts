/**
 * PrismaPppoeServiceRepository — adapter unit tests with mocked Prisma client.
 * pppoe-bulk-select-filter (v2).
 *
 * Purpose (task 1.1, approval tests): pin the WHERE shape `listAllPaginated` sends to
 * Prisma BEFORE extracting it into a shared `buildListAllWhere(params)` helper. These
 * tests must still pass AFTER the extraction — that's the proof the refactor did not
 * change behavior (approval testing pattern, see PrismaClosedServiceOrderRepository
 * .pendingWhere.test.ts / PrismaNetworkSiteRepository.test.ts).
 *
 * Purpose (tasks 1.2/1.3, RED→GREEN): `listAllIds(params)` is a NEW port method. Its
 * WHERE MUST be byte-for-byte identical to `listAllPaginated`'s WHERE for the SAME
 * filter params — that's the guardrail against list↔ids drift (design Decision 1).
 * Assert both by comparing the two captured `where` objects with `toEqual`.
 */

// Mock the prisma singleton before importing the repository.
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    pppoeService: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaPppoeServiceRepository } from '../../infrastructure/adapters/prisma/PrismaPppoeServiceRepository';

const mockPrisma = prisma as unknown as {
  pppoeService: { findMany: jest.Mock; count: jest.Mock };
};

describe('PrismaPppoeServiceRepository — listAllPaginated WHERE shape (approval, pre/post-refactor)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.pppoeService.findMany.mockResolvedValue([]);
    mockPrisma.pppoeService.count.mockResolvedValue(0);
  });

  it('no filters (includeUnassigned default false): WHERE is AND[{contractId:{not:null}}]', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllPaginated({ page: 1, pageSize: 25 });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ AND: [{ contractId: { not: null } }] });
    // count() must use the SAME where as findMany (paginator total).
    expect(mockPrisma.pppoeService.count.mock.calls[0][0].where).toEqual(where);
  });

  it('includeUnassigned=true: contractId leg is OMITTED from AND', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllPaginated({ page: 1, pageSize: 25, includeUnassigned: true });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    expect(where).toEqual({});
  });

  it('nasId filter: AND includes { nasId }', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllPaginated({ page: 1, pageSize: 25, includeUnassigned: true, nasId: 'NE8000-1' });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ AND: [{ nasId: 'NE8000-1' }] });
  });

  it('search that looks like an IP (has a dot): OR does NOT add callerId (MAC) branches', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllPaginated({ page: 1, pageSize: 25, includeUnassigned: true, search: '100.64.28.5' });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(1);
    const or = where.AND[0].OR;
    expect(or).toEqual([
      { username: { contains: '100.64.28.5', mode: 'insensitive' } },
      { contract: { is: { client: { is: { name: { contains: '100.64.28.5', mode: 'insensitive' } } } } } },
      { remoteAddress: { contains: '100.64.28.5', mode: 'insensitive' } },
    ]);
  });

  it('search that looks like a MAC: OR adds callerId variants (raw/colon/dash/plain)', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllPaginated({ page: 1, pageSize: 25, includeUnassigned: true, search: 'aabbccddeeff' });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    const or = where.AND[0].OR;
    // base 3 branches + 3 callerId variants (raw==plain when already lowercase+unseparated, deduped)
    expect(or).toEqual(
      expect.arrayContaining([
        { callerId: { contains: 'aa:bb:cc:dd:ee:ff', mode: 'insensitive' } },
        { callerId: { contains: 'aa-bb-cc-dd-ee-ff', mode: 'insensitive' } },
        { callerId: { contains: 'aabbccddeeff', mode: 'insensitive' } },
      ]),
    );
  });

  it('displayStatus=reduced: AND includes the translated predicate', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllPaginated({ page: 1, pageSize: 25, includeUnassigned: true, displayStatus: 'reduced' });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      AND: [{ status: { notIn: ['terminated', 'disabled'] }, enforcedState: 'reduced' }],
    });
  });

  it('combination nasId + search + displayStatus + includeUnassigned=false: AND has 4 independent fragments', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllPaginated({
      page: 1,
      pageSize: 25,
      nasId: 'NE8000-1',
      search: 'juan',
      displayStatus: 'active',
    });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { contractId: { not: null } },
      { nasId: 'NE8000-1' },
      {
        OR: [
          { username: { contains: 'juan', mode: 'insensitive' } },
          { contract: { is: { client: { is: { name: { contains: 'juan', mode: 'insensitive' } } } } } },
          { remoteAddress: { contains: 'juan', mode: 'insensitive' } },
        ],
      },
      { status: 'enabled', enforcedState: 'active' },
    ]);
  });
});

describe('PrismaPppoeServiceRepository — listAllIds (pppoe-bulk-select-filter, tasks 1.2/1.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.pppoeService.findMany.mockResolvedValue([]);
    mockPrisma.pppoeService.count.mockResolvedValue(0);
  });

  it('for the SAME filter params, listAllIds sends the IDENTICAL where as listAllPaginated (drift guardrail)', async () => {
    const repo = new PrismaPppoeServiceRepository();
    const filterParams = { nasId: 'NE8000-1', search: 'juan', displayStatus: 'active' as const, includeUnassigned: false };

    await repo.listAllPaginated({ page: 1, pageSize: 25, ...filterParams });
    const paginatedWhere = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;

    jest.clearAllMocks();
    mockPrisma.pppoeService.findMany.mockResolvedValue([]);
    mockPrisma.pppoeService.count.mockResolvedValue(0);

    await repo.listAllIds(filterParams);
    const idsWhere = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;

    expect(idsWhere).toEqual(paginatedWhere);
    expect(mockPrisma.pppoeService.count.mock.calls[0][0].where).toEqual(paginatedWhere);
  });

  it('findMany is called with a LIGHT projection (select: { id: true }), NOT the full list select', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllIds({ nasId: 'NE8000-1' });

    const call = mockPrisma.pppoeService.findMany.mock.calls[0][0];
    expect(call.select).toEqual({ id: true });
    expect(call.orderBy).toEqual({ username: 'asc' });
  });

  it('maps rows to { ids, total } with total from count()', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    mockPrisma.pppoeService.count.mockResolvedValue(3);

    const repo = new PrismaPppoeServiceRepository();
    const result = await repo.listAllIds({ nasId: 'NE8000-1' });

    expect(result.ids).toEqual(['a', 'b', 'c']);
    expect(result.total).toBe(3);
    expect(result.ids.length).toBe(result.total);
  });

  it('no filters at all: where is {} (same as listAllPaginated with includeUnassigned=true and no other filter)', async () => {
    const repo = new PrismaPppoeServiceRepository();
    await repo.listAllIds({ includeUnassigned: true });

    const where = mockPrisma.pppoeService.findMany.mock.calls[0][0].where;
    expect(where).toEqual({});
  });
});
