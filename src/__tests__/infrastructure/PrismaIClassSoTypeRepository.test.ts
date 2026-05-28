/**
 * Unit tests for PrismaIClassSoTypeRepository.
 * Uses jest.mock to stub the Prisma singleton — no real DB required.
 * Pattern mirrors PrismaSchedulingRepository.methods.test.ts.
 */

// Mock the prisma singleton BEFORE importing anything that uses it
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    iClassSoType: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { PrismaIClassSoTypeRepository } from '../../infrastructure/adapters/prisma/PrismaIClassSoTypeRepository';
import { prisma } from '../../infrastructure/database/prisma';

type MockPrisma = {
  iClassSoType: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};
const mockPrisma = prisma as unknown as MockPrisma;

const NOW = new Date('2026-05-28T10:00:00.000Z');

function makeRow(overrides: Partial<{
  id: string; code: string; description: string; active: boolean;
  lastSyncedAt: Date; createdAt: Date; updatedAt: Date;
}> = {}) {
  return {
    id: 'uuid-1',
    code: 'INSTALL',
    description: 'Instalación',
    active: true,
    lastSyncedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  jest.resetAllMocks();
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('PrismaIClassSoTypeRepository.list', () => {
  it('returns all entries when no filter provided', async () => {
    const rows = [makeRow({ id: '1', code: 'A' }), makeRow({ id: '2', code: 'B', active: false })];
    mockPrisma.iClassSoType.findMany.mockResolvedValue(rows);

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.list();

    expect(mockPrisma.iClassSoType.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { code: 'asc' },
    });
    expect(result).toHaveLength(2);
    expect(result[0].code).toBe('A');
    expect(result[0].lastSyncedAt).toBeInstanceOf(Date);
  });

  it('passes active filter when provided', async () => {
    mockPrisma.iClassSoType.findMany.mockResolvedValue([makeRow()]);

    const repo = new PrismaIClassSoTypeRepository();
    await repo.list({ active: true });

    expect(mockPrisma.iClassSoType.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { code: 'asc' },
    });
  });

  it('passes active=false filter when provided', async () => {
    mockPrisma.iClassSoType.findMany.mockResolvedValue([]);

    const repo = new PrismaIClassSoTypeRepository();
    await repo.list({ active: false });

    expect(mockPrisma.iClassSoType.findMany).toHaveBeenCalledWith({
      where: { active: false },
      orderBy: { code: 'asc' },
    });
  });
});

// ─── getById ──────────────────────────────────────────────────────────────────

describe('PrismaIClassSoTypeRepository.getById', () => {
  it('returns null when not found', async () => {
    mockPrisma.iClassSoType.findUnique.mockResolvedValue(null);

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.getById('non-existent');

    expect(result).toBeNull();
  });

  it('returns mapped entity when found', async () => {
    mockPrisma.iClassSoType.findUnique.mockResolvedValue(makeRow());

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.getById('uuid-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('uuid-1');
    expect(result!.code).toBe('INSTALL');
    expect(result!.lastSyncedAt).toBeInstanceOf(Date);
  });
});

// ─── getByCode ────────────────────────────────────────────────────────────────

describe('PrismaIClassSoTypeRepository.getByCode', () => {
  it('returns null when not found', async () => {
    mockPrisma.iClassSoType.findUnique.mockResolvedValue(null);

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.getByCode('NONEXISTENT');

    expect(result).toBeNull();
    expect(mockPrisma.iClassSoType.findUnique).toHaveBeenCalledWith({
      where: { code: 'NONEXISTENT' },
    });
  });

  it('returns mapped entity when found', async () => {
    mockPrisma.iClassSoType.findUnique.mockResolvedValue(makeRow({ code: 'FIBRA' }));

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.getByCode('FIBRA');

    expect(result!.code).toBe('FIBRA');
  });
});

// ─── upsertByCode ─────────────────────────────────────────────────────────────

describe('PrismaIClassSoTypeRepository.upsertByCode', () => {
  it('returns { status: "created" } when no existing row', async () => {
    // First findUnique call (pre-query) → null (doesn't exist)
    mockPrisma.iClassSoType.findUnique.mockResolvedValue(null);
    mockPrisma.iClassSoType.upsert.mockResolvedValue(makeRow());

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.upsertByCode({ code: 'INSTALL', description: 'Instalación' });

    expect(result.status).toBe('created');
    expect(mockPrisma.iClassSoType.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: 'INSTALL' },
        create: expect.objectContaining({ code: 'INSTALL', description: 'Instalación', active: true }),
        update: expect.objectContaining({ description: 'Instalación', active: true }),
      }),
    );
  });

  it('returns { status: "updated" } when existing row is active', async () => {
    mockPrisma.iClassSoType.findUnique.mockResolvedValue(makeRow({ active: true }));
    mockPrisma.iClassSoType.upsert.mockResolvedValue(makeRow());

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.upsertByCode({ code: 'INSTALL', description: 'Instalación v2' });

    expect(result.status).toBe('updated');
  });

  it('returns { status: "reactivated" } when existing row is inactive', async () => {
    mockPrisma.iClassSoType.findUnique.mockResolvedValue(makeRow({ active: false }));
    mockPrisma.iClassSoType.upsert.mockResolvedValue(makeRow({ active: true }));

    const repo = new PrismaIClassSoTypeRepository();
    const result = await repo.upsertByCode({ code: 'INSTALL', description: 'Instalación' });

    expect(result.status).toBe('reactivated');
  });
});

// ─── markInactiveExcept ───────────────────────────────────────────────────────

describe('PrismaIClassSoTypeRepository.markInactiveExcept', () => {
  it('calls updateMany with notIn filter and returns count', async () => {
    mockPrisma.iClassSoType.updateMany.mockResolvedValue({ count: 3 });

    const repo = new PrismaIClassSoTypeRepository();
    const count = await repo.markInactiveExcept(['A', 'B']);

    expect(count).toBe(3);
    expect(mockPrisma.iClassSoType.updateMany).toHaveBeenCalledWith({
      where: { code: { notIn: ['A', 'B'] }, active: true },
      data: expect.objectContaining({ active: false }),
    });
  });

  it('deactivates all active rows when presentCodes is empty', async () => {
    mockPrisma.iClassSoType.updateMany.mockResolvedValue({ count: 5 });

    const repo = new PrismaIClassSoTypeRepository();
    const count = await repo.markInactiveExcept([]);

    expect(count).toBe(5);
    // Empty notIn means deactivate all active rows
    expect(mockPrisma.iClassSoType.updateMany).toHaveBeenCalledWith({
      where: { code: { notIn: [] }, active: true },
      data: expect.objectContaining({ active: false }),
    });
  });

  it('issues a single updateMany call (AD-6: no N round-trips)', async () => {
    mockPrisma.iClassSoType.updateMany.mockResolvedValue({ count: 2 });

    const repo = new PrismaIClassSoTypeRepository();
    await repo.markInactiveExcept(['X', 'Y', 'Z']);

    // Single bulk call, not one per code
    expect(mockPrisma.iClassSoType.updateMany).toHaveBeenCalledTimes(1);
  });
});
