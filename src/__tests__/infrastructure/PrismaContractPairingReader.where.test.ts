/**
 * PrismaContractPairingReader — adapter intention tests with mocked Prisma client
 * (patrón PrismaPppoeServiceRepository.listAllWhere.test.ts). actions-worklist fix wave:
 *
 * - M2/B1 + fix wave 2: findTitularityBajas SIN ventana — cap `take: limit` que DRENA
 *   por exclusión explícita de las bajas ya caseadas (`id NOT IN excludeContractIds`,
 *   omitido si la lista viene vacía). El orden estable (createdAt DESC + id ASC) es un
 *   detalle determinístico, NO el mecanismo de drenaje (createdAt es fecha de fila del
 *   mirror, no de baja — "newest-first drena" era falso).
 * - M3: findRecentBajas exige motivoBaja NOT NULL (proxy forward-only de "reciente" —
 *   las bajas históricas del backfill tienen NULL) y reescribe el NULL-handling del
 *   excludeTitularity (ya no hay OR con motivoBaja:null).
 * - H1: getContract(id) — lectura puntual para re-pareo y validación de set-target.
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    contract: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaContractPairingReader } from '../../infrastructure/adapters/prisma/PrismaContractPairingReader';
import { TITULARITY_MOTIVO } from '../../domain/entities/ownershipCase';

const mockPrisma = prisma as unknown as {
  contract: { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
};

const ROW = {
  id: 'ct-1',
  clientId: 'cli-1',
  address: 'MITRE 100',
  startDate: new Date('2024-05-01T00:00:00.000Z'),
  motivoBaja: 'CAMBIO DE TITULARIDAD',
  status: 'baja',
};

describe('PrismaContractPairingReader — findTitularityBajas (M2/B1 + fix wave 2: cap que drena)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contract.findMany.mockResolvedValue([]);
  });

  it('WHERE: status baja (insensitive) + motivo titularidad (contains insensitive) — SIN filtro temporal; exclusión vacía OMITE el notIn', async () => {
    const reader = new PrismaContractPairingReader();
    await reader.findTitularityBajas({ limit: 500, excludeContractIds: [] });

    const call = mockPrisma.contract.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      status: { equals: 'baja', mode: 'insensitive' },
      motivoBaja: { contains: TITULARITY_MOTIVO, mode: 'insensitive' },
    });
  });

  it('excluye las bajas ya caseadas: id notIn excludeContractIds (el cap drena)', async () => {
    const reader = new PrismaContractPairingReader();
    await reader.findTitularityBajas({ limit: 500, excludeContractIds: ['ct-a', 'ct-b'] });

    const call = mockPrisma.contract.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      status: { equals: 'baja', mode: 'insensitive' },
      motivoBaja: { contains: TITULARITY_MOTIVO, mode: 'insensitive' },
      id: { notIn: ['ct-a', 'ct-b'] },
    });
  });

  it('cap por tick: take = limit con orden estable (createdAt DESC + id ASC — detalle determinístico)', async () => {
    const reader = new PrismaContractPairingReader();
    await reader.findTitularityBajas({ limit: 500, excludeContractIds: [] });

    const call = mockPrisma.contract.findMany.mock.calls[0][0];
    expect(call.take).toBe(500);
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('PrismaContractPairingReader — findRecentBajas (M3: "reciente" honesto)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contract.findMany.mockResolvedValue([]);
    mockPrisma.contract.count.mockResolvedValue(0);
  });

  it('WHERE base exige motivoBaja NOT NULL (las bajas históricas del backfill quedan fuera)', async () => {
    const reader = new PrismaContractPairingReader();
    await reader.findRecentBajas({ excludeTitularity: false, page: 1, pageSize: 25 });

    const where = mockPrisma.contract.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      status: { equals: 'baja', mode: 'insensitive' },
      motivoBaja: { not: null },
    });
    // count() usa el MISMO where (total del paginador)
    expect(mockPrisma.contract.count.mock.calls[0][0].where).toEqual(where);
  });

  it('excludeTitularity=true: agrega NOT contains titularidad SIN el viejo OR de motivo null', async () => {
    const reader = new PrismaContractPairingReader();
    await reader.findRecentBajas({ excludeTitularity: true, page: 1, pageSize: 25 });

    const where = mockPrisma.contract.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      status: { equals: 'baja', mode: 'insensitive' },
      motivoBaja: { not: null },
      NOT: { motivoBaja: { contains: TITULARITY_MOTIVO, mode: 'insensitive' } },
    });
    expect(where.OR).toBeUndefined();
  });

  it('paginación y orden estable: skip/take + createdAt DESC + id ASC', async () => {
    const reader = new PrismaContractPairingReader();
    await reader.findRecentBajas({ excludeTitularity: true, page: 3, pageSize: 10 });

    const call = mockPrisma.contract.findMany.mock.calls[0][0];
    expect(call.skip).toBe(20);
    expect(call.take).toBe(10);
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('PrismaContractPairingReader — findActivePairingCandidates (pin del where F0)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contract.findMany.mockResolvedValue([]);
  });

  it('WHERE: NOT baja (insensitive) + startDate exacto + address exacto + cliente distinto', async () => {
    const reader = new PrismaContractPairingReader();
    await reader.findActivePairingCandidates({
      startDate: '2024-05-01T00:00:00.000Z',
      address: 'MITRE 100',
      excludeClientId: 'cli-1',
    });

    const where = mockPrisma.contract.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      NOT: { status: { equals: 'baja', mode: 'insensitive' } },
      startDate: new Date('2024-05-01T00:00:00.000Z'),
      address: 'MITRE 100',
      clientId: { not: 'cli-1' },
    });
  });
});

describe('PrismaContractPairingReader — getContract (H1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('findUnique por id con la proyección de pairing y mapeo a dominio', async () => {
    mockPrisma.contract.findUnique.mockResolvedValue(ROW);
    const reader = new PrismaContractPairingReader();

    const result = await reader.getContract('ct-1');

    const call = mockPrisma.contract.findUnique.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'ct-1' });
    expect(result).toEqual({
      id: 'ct-1',
      clientId: 'cli-1',
      address: 'MITRE 100',
      startDate: '2024-05-01T00:00:00.000Z',
      motivoBaja: 'CAMBIO DE TITULARIDAD',
      status: 'baja',
    });
  });

  it('null cuando el contrato no existe', async () => {
    mockPrisma.contract.findUnique.mockResolvedValue(null);
    const reader = new PrismaContractPairingReader();

    expect(await reader.getContract('nope')).toBeNull();
  });
});
