/**
 * service-transfer FIX WAVE 2 (FIX-4) — test de INTENCIÓN Prisma para
 * `findActiveByCatalogAndNotesPrefix` (mismo techo de cobertura que
 * PrismaContractInventoryRepository.transfer.test.ts: se pinnea la query EXACTA que emite el
 * adapter — no un re-read de Postgres real; el repo no tiene pg-mem/testcontainer hoy). Como
 * PrismaContractServiceRepository usa el singleton `prisma` (no inyección por constructor), el
 * seam es el mock del módulo, patrón PrismaPppoeServiceRepository.listAllWhere.test.ts.
 *
 * Contrato pineado (TransferTvToCustomer depende de ESTA forma):
 *   - WHERE { serviceCatalogId, status: 'active', notes: { startsWith: prefix } } — SOLO filas
 *     ACTIVAS (FIX-3: el retry resume debe encontrar las credenciales del origen aún activo) y
 *     por PREFIJO (el caller re-valida el cic exacto con cicFromNotes — "CIC 123" también
 *     matchea "CIC 1234", MEDIUM-1).
 *   - findMany (TODAS las candidatas, no findFirst) con orderBy createdAt asc (determinístico).
 *   - include serviceCatalog (el view necesita name/label del join).
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    contractService: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaContractServiceRepository } from '@infrastructure/adapters/prisma/PrismaContractServiceRepository';

const mockPrisma = prisma as unknown as {
  contractService: { findMany: jest.Mock };
};

describe('PrismaContractServiceRepository.findActiveByCatalogAndNotesPrefix — intención (query pineada)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contractService.findMany.mockResolvedValue([]);
  });

  it('emite findMany WHERE { serviceCatalogId, status:"active", notes:{startsWith:prefix} } + orderBy createdAt asc + include serviceCatalog', async () => {
    const repo = new PrismaContractServiceRepository();
    await repo.findActiveByCatalogAndNotesPrefix('cat-tv', 'CIC 0000000001');

    expect(mockPrisma.contractService.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contractService.findMany.mock.calls[0][0]).toEqual({
      where: { serviceCatalogId: 'cat-tv', status: 'active', notes: { startsWith: 'CIC 0000000001' } },
      include: { serviceCatalog: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('mapea TODAS las filas al view (findMany, no findFirst): join name/label, credenciales y fechas ISO', async () => {
    mockPrisma.contractService.findMany.mockResolvedValue([
      {
        id: 'cs-1', contractId: 'C-A', serviceCatalogId: 'cat-tv', status: 'active',
        notes: 'CIC 0000000001 · Gigared Play Full', tvLogin: 'GIGA100', tvPassword: 'ip243200',
        createdAt: new Date('2026-07-01T10:00:00.000Z'), deactivatedAt: null,
        serviceCatalog: { name: 'TV', label: 'TV' },
      },
      {
        id: 'cs-2', contractId: 'C-OLD', serviceCatalogId: 'cat-tv', status: 'active',
        notes: 'CIC 0000000001 · Residuo parcial', tvLogin: null, tvPassword: null,
        createdAt: new Date('2026-07-02T10:00:00.000Z'), deactivatedAt: null,
        serviceCatalog: { name: 'TV', label: 'TV' },
      },
    ]);
    const repo = new PrismaContractServiceRepository();
    const rows = await repo.findActiveByCatalogAndNotesPrefix('cat-tv', 'CIC 0000000001');

    expect(rows).toEqual([
      {
        id: 'cs-1', contractId: 'C-A', serviceCatalogId: 'cat-tv', name: 'TV', label: 'TV',
        status: 'active', notes: 'CIC 0000000001 · Gigared Play Full',
        tvLogin: 'GIGA100', tvPassword: 'ip243200',
        createdAt: '2026-07-01T10:00:00.000Z', deactivatedAt: null,
      },
      {
        id: 'cs-2', contractId: 'C-OLD', serviceCatalogId: 'cat-tv', name: 'TV', label: 'TV',
        status: 'active', notes: 'CIC 0000000001 · Residuo parcial',
        tvLogin: null, tvPassword: null,
        createdAt: '2026-07-02T10:00:00.000Z', deactivatedAt: null,
      },
    ]);
  });
});
