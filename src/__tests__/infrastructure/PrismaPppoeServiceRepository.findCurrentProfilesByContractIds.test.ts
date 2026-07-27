/**
 * finance-growth fix-wave-2 — PrismaPppoeServiceRepository.findCurrentProfilesByContractIds.
 * Adapter unit tests with a mocked Prisma client (molde
 * `PrismaPppoeServiceRepository.listAllWhere.test.ts`).
 *
 * Purpose: (1) pin that resolution is a SINGLE batch query
 * (`contractId: { in: [...] }`), never N+1; (2) prove the tie-break for a
 * contract with MULTIPLE PppoeService rows delegates to the SHARED domain
 * helper `pickCurrentPppoeService` — the EXACT same function
 * `InMemoryPppoeServiceRepository` uses — so the two adapters cannot
 * independently drift on this criterion (the class of bug this change
 * already hit once, per design.md).
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    pppoeService: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaPppoeServiceRepository } from '../../infrastructure/adapters/prisma/PrismaPppoeServiceRepository';

const mockPrisma = prisma as unknown as {
  pppoeService: { findMany: jest.Mock };
};

function row(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'id-default',
    username: 'user-default',
    password: 'secret',
    profile: null,
    remoteAddress: null,
    status: 'enabled',
    enforcedState: 'active',
    nasId: 'nas-1',
    contractId: null,
    callerId: null,
    ipMode: 'fixed',
    ipTypePreference: 'cgnat',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PrismaPppoeServiceRepository.findCurrentProfilesByContractIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('empty contractIds: returns an empty Map WITHOUT ever calling Prisma (short-circuit, no wasted round trip)', async () => {
    const repo = new PrismaPppoeServiceRepository();
    const map = await repo.findCurrentProfilesByContractIds([]);
    expect(map.size).toBe(0);
    expect(mockPrisma.pppoeService.findMany).not.toHaveBeenCalled();
  });

  it('issues ONE batch query with contractId IN (...) — never N+1', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([]);
    const repo = new PrismaPppoeServiceRepository();
    await repo.findCurrentProfilesByContractIds(['C1', 'C2', 'C3']);

    expect(mockPrisma.pppoeService.findMany).toHaveBeenCalledTimes(1);
    // fix-wave-3 (🟡 3 determinism + 🔵 secrets) — `orderBy` (defense in depth
    // alongside the domain tiebreak) + an explicit `select` that OMITS
    // `password`/`username`/etc: this projection resolves a plan CODE only.
    expect(mockPrisma.pppoeService.findMany).toHaveBeenCalledWith({
      where: { contractId: { in: ['C1', 'C2', 'C3'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true, contractId: true, profile: true, status: true, createdAt: true },
    });
  });

  it('NEVER reads `password` into memory for this projection (fix-wave-3 🔵 secrets — was findMany() with NO select at all, fetching every PPPoE field including the RADIUS password)', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([
      row({ id: 'p1', contractId: 'C1', profile: 'IP-30', password: 'super-secret' }),
    ]);
    const repo = new PrismaPppoeServiceRepository();
    await repo.findCurrentProfilesByContractIds(['C1']);

    const callArgs = mockPrisma.pppoeService.findMany.mock.calls[0][0];
    expect(callArgs.select).toBeDefined();
    expect(callArgs.select.password).toBeUndefined();
  });

  it('fix-wave-3 (🟡 3) — a tie on BOTH rank (enabled) AND createdAt resolves to the SAME winner regardless of the order Postgres returns the rows in (measured: same rows, different fetch order used to yield MRR 10000 vs 15000)', async () => {
    const tiedCreatedAt = new Date('2026-05-01T00:00:00.000Z');
    const rowA = row({ id: 'aaaa', contractId: 'C1', profile: 'IP-30', status: 'enabled', createdAt: tiedCreatedAt });
    const rowB = row({ id: 'bbbb', contractId: 'C1', profile: 'IP-100', status: 'enabled', createdAt: tiedCreatedAt });

    mockPrisma.pppoeService.findMany.mockResolvedValueOnce([rowA, rowB]);
    const repo1 = new PrismaPppoeServiceRepository();
    const map1 = await repo1.findCurrentProfilesByContractIds(['C1']);

    mockPrisma.pppoeService.findMany.mockResolvedValueOnce([rowB, rowA]); // SAME rows, REVERSED input order
    const repo2 = new PrismaPppoeServiceRepository();
    const map2 = await repo2.findCurrentProfilesByContractIds(['C1']);

    // 'aaaa' < 'bbbb' lexicographically — the id tiebreak picks it deterministically both times.
    expect(map1.get('C1')).toBe('IP-30');
    expect(map2.get('C1')).toBe('IP-30');
  });

  it('a contract with ONE row: resolves its profile', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([
      row({ id: 'p1', username: 'u1', contractId: 'C1', profile: 'IP-30' }),
    ]);
    const repo = new PrismaPppoeServiceRepository();
    const map = await repo.findCurrentProfilesByContractIds(['C1']);
    expect(map.get('C1')).toBe('IP-30');
  });

  it('a contract with MULTIPLE rows: tie-break prefers enabled over terminated, regardless of createdAt order (SHARED with InMemory via pickCurrentPppoeService)', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([
      row({ id: 'p1', username: 'old-terminated', contractId: 'C1', profile: 'IP-30', status: 'terminated', createdAt: new Date('2020-01-01') }),
      row({ id: 'p2', username: 'new-enabled', contractId: 'C1', profile: 'IP-100', status: 'enabled', createdAt: new Date('2020-06-01') }),
    ]);
    const repo = new PrismaPppoeServiceRepository();
    const map = await repo.findCurrentProfilesByContractIds(['C1']);
    expect(map.get('C1')).toBe('IP-100');
  });

  it('a contract whose ONLY rows are terminated still resolves the most recent terminated profile (better than nothing, never crashes)', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([
      row({ id: 'p1', username: 'gone', contractId: 'C1', profile: 'IP-30', status: 'terminated' }),
    ]);
    const repo = new PrismaPppoeServiceRepository();
    const map = await repo.findCurrentProfilesByContractIds(['C1']);
    expect(map.get('C1')).toBe('IP-30');
  });

  it('a contractId with NO matching rows at all is ABSENT from the returned Map (never a fabricated null entry)', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([]);
    const repo = new PrismaPppoeServiceRepository();
    const map = await repo.findCurrentProfilesByContractIds(['C-nope']);
    expect(map.has('C-nope')).toBe(false);
  });

  it('batch resolves several contracts from the SAME query result, each with its own winner', async () => {
    mockPrisma.pppoeService.findMany.mockResolvedValue([
      row({ id: 'p1', username: 'a', contractId: 'C1', profile: 'IP-30' }),
      row({ id: 'p2', username: 'b', contractId: 'C2', profile: 'IP-100' }),
    ]);
    const repo = new PrismaPppoeServiceRepository();
    const map = await repo.findCurrentProfilesByContractIds(['C1', 'C2', 'C3']);
    expect(map.get('C1')).toBe('IP-30');
    expect(map.get('C2')).toBe('IP-100');
    expect(map.has('C3')).toBe(false);
  });
});
