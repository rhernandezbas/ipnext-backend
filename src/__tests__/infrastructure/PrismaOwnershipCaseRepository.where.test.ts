/**
 * PrismaOwnershipCaseRepository — adapter intention tests with mocked Prisma client
 * (patrón PrismaPppoeServiceRepository.listAllWhere.test.ts). actions-worklist fix wave:
 *
 * - M1: flipToDone es un CAS — updateMany con WHERE condicional
 *   {id, status:'pending', equipmentReviewed:true}; count===1 confirma el flip.
 *   Un dismiss concurrente entre lectura y flip hace count 0 → false (no se pisa).
 * - H1a: listPristineUnpaired — WHERE de "prístino" (pending, sin target, candidates
 *   SQL NULL, sin review manual) con cap y orden FIFO estable.
 * - L7: list ordena detectedAt DESC + id ASC (paridad con el InMemory).
 * - Fix wave 2: updateIfPristine es el CAS del re-pareo — updateMany con el WHERE
 *   prístino COMPLETO (mismo shape que listPristineUnpaired, candidates DbNull);
 *   count 0 = el operador movió el caso entre el listado y el write → no se toca.
 * - Fix wave 2: listAllSourceContractIds — select fino sin where (todos los status
 *   cuentan) para excluir del scan las bajas ya caseadas (el cap drena).
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    ownershipTransferCase: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { PrismaOwnershipCaseRepository } from '../../infrastructure/adapters/prisma/PrismaOwnershipCaseRepository';

const mockPrisma = prisma as unknown as {
  ownershipTransferCase: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
};

describe('PrismaOwnershipCaseRepository — flipToDone (M1: CAS)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updateMany con WHERE condicional {id, status:pending, equipmentReviewed:true} → data {status:done}', async () => {
    mockPrisma.ownershipTransferCase.updateMany.mockResolvedValue({ count: 1 });
    const repo = new PrismaOwnershipCaseRepository();

    const flipped = await repo.flipToDone('case-1');

    expect(flipped).toBe(true);
    const call = mockPrisma.ownershipTransferCase.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'case-1', status: 'pending', equipmentReviewed: true });
    expect(call.data).toEqual({ status: 'done' });
  });

  it('count 0 (dismiss concurrente / condición no cumplida) → false', async () => {
    mockPrisma.ownershipTransferCase.updateMany.mockResolvedValue({ count: 0 });
    const repo = new PrismaOwnershipCaseRepository();

    expect(await repo.flipToDone('case-1')).toBe(false);
  });
});

describe('PrismaOwnershipCaseRepository — listPristineUnpaired (H1a)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ownershipTransferCase.findMany.mockResolvedValue([]);
  });

  it('WHERE de prístino: pending + sin target + candidates SQL NULL + sin review; cap + orden FIFO', async () => {
    const repo = new PrismaOwnershipCaseRepository();
    await repo.listPristineUnpaired(500);

    const call = mockPrisma.ownershipTransferCase.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      status: 'pending',
      targetContractId: null,
      candidates: { equals: Prisma.DbNull },
      equipmentReviewed: false,
    });
    expect(call.take).toBe(500);
    expect(call.orderBy).toEqual([{ detectedAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('PrismaOwnershipCaseRepository — updateIfPristine (fix wave 2: CAS del re-pareo)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updateMany con el WHERE prístino COMPLETO {id, pending, sin target, candidates DbNull, sin review}', async () => {
    mockPrisma.ownershipTransferCase.updateMany.mockResolvedValue({ count: 1 });
    const repo = new PrismaOwnershipCaseRepository();

    const ok = await repo.updateIfPristine('case-1', {
      targetContractId: 'ct-2',
      targetClientId: 'cli-2',
    });

    expect(ok).toBe(true);
    const call = mockPrisma.ownershipTransferCase.updateMany.mock.calls[0][0];
    // El WHERE matchea EXACTAMENTE el shape prístino que escriben create/update:
    // "sin candidates" = SQL NULL = Prisma.DbNull (create omite el campo, update
    // escribe DbNull — nunca JSON null). Mismo filtro que listPristineUnpaired.
    expect(call.where).toEqual({
      id: 'case-1',
      status: 'pending',
      targetContractId: null,
      candidates: { equals: Prisma.DbNull },
      equipmentReviewed: false,
    });
    expect(call.data).toEqual({ targetContractId: 'ct-2', targetClientId: 'cli-2' });
  });

  it('promoción a ambiguous: data mapea status + candidates como JSON (no DbNull)', async () => {
    mockPrisma.ownershipTransferCase.updateMany.mockResolvedValue({ count: 1 });
    const repo = new PrismaOwnershipCaseRepository();

    const candidates = [
      { contractId: 'a', clientId: 'ca' },
      { contractId: 'b', clientId: 'cb' },
    ];
    const ok = await repo.updateIfPristine('case-1', { status: 'ambiguous', candidates });

    expect(ok).toBe(true);
    const call = mockPrisma.ownershipTransferCase.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ status: 'ambiguous', candidates });
  });

  it('count 0 (dismiss/set-target concurrente entre el listado y el write) → false', async () => {
    mockPrisma.ownershipTransferCase.updateMany.mockResolvedValue({ count: 0 });
    const repo = new PrismaOwnershipCaseRepository();

    expect(await repo.updateIfPristine('case-1', { targetContractId: 'ct-2' })).toBe(false);
  });
});

describe('PrismaOwnershipCaseRepository — listAllSourceContractIds (fix wave 2: el cap drena)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('findMany con select fino {sourceContractId} SIN where (todos los status cuentan)', async () => {
    mockPrisma.ownershipTransferCase.findMany.mockResolvedValue([
      { sourceContractId: 'ct-a' },
      { sourceContractId: 'ct-b' },
    ]);
    const repo = new PrismaOwnershipCaseRepository();

    const ids = await repo.listAllSourceContractIds();

    expect(ids).toEqual(['ct-a', 'ct-b']);
    const call = mockPrisma.ownershipTransferCase.findMany.mock.calls[0][0];
    expect(call).toEqual({ select: { sourceContractId: true } });
  });
});

describe('PrismaOwnershipCaseRepository — list (L7: paridad de orden)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ownershipTransferCase.findMany.mockResolvedValue([]);
    mockPrisma.ownershipTransferCase.count.mockResolvedValue(0);
  });

  it('ordena por detectedAt DESC con desempate id ASC (mismo orden que el InMemory)', async () => {
    const repo = new PrismaOwnershipCaseRepository();
    await repo.list({ page: 1, pageSize: 25 });

    const call = mockPrisma.ownershipTransferCase.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ detectedAt: 'desc' }, { id: 'asc' }]);
  });
});
