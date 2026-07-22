/**
 * gigared-tv-identity-hardening (D4/B4) — test de INTENCIÓN Prisma para
 * `findActiveTvOwnersByCics` (mismo techo de cobertura que
 * PrismaContractServiceRepository.findActiveByNotesPrefix.test.ts): se pinnea la query EXACTA
 * que emite el adapter — UNA sola findMany (N+1 PROHIBIDO, este método alimenta el endpoint de
 * operadores `GET /api/gigared/accounts`), con un OR de `startsWith` por cada cic del batch y
 * el JOIN a `contract` para traer el `clientId` sin una lookup por fila.
 *
 * Contrato pineado (ListGigaredAccounts depende de ESTA forma):
 *   - WHERE { serviceCatalogId, status: 'active', OR: cics.map(c => ({ notes: { startsWith: `CIC ${c}` } })) }
 *   - select: { notes: true, contract: { select: { clientId: true } } }
 *   - orderBy: { createdAt: 'asc' } (first-row-wins determinístico para el caller)
 *   - UNA sola llamada a findMany por batch, nunca una por cic/cuenta.
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

describe('PrismaContractServiceRepository.findActiveTvOwnersByCics — intención (query pineada)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contractService.findMany.mockResolvedValue([]);
  });

  it('emite UNA findMany WHERE { serviceCatalogId, status:"active", OR: [startsWith por cic] } + select notes/contract.clientId + orderBy createdAt asc', async () => {
    const repo = new PrismaContractServiceRepository();
    await repo.findActiveTvOwnersByCics('cat-tv', ['0000000001', '0000000002']);

    expect(mockPrisma.contractService.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contractService.findMany.mock.calls[0][0]).toEqual({
      where: {
        serviceCatalogId: 'cat-tv',
        status: 'active',
        OR: [
          { notes: { startsWith: 'CIC 0000000001' } },
          { notes: { startsWith: 'CIC 0000000002' } },
        ],
      },
      select: { notes: true, contract: { select: { clientId: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('mapea cada fila a { notes, clientId } tomado del contract JOIN — sin lookup por fila', async () => {
    mockPrisma.contractService.findMany.mockResolvedValue([
      { notes: 'CIC 0000000001 · Gigared Play Full', contract: { clientId: 'client-A' } },
      { notes: 'CIC 0000000002 · Residuo', contract: { clientId: 'client-B' } },
    ]);
    const repo = new PrismaContractServiceRepository();
    const rows = await repo.findActiveTvOwnersByCics('cat-tv', ['0000000001', '0000000002']);

    expect(rows).toEqual([
      { notes: 'CIC 0000000001 · Gigared Play Full', clientId: 'client-A' },
      { notes: 'CIC 0000000002 · Residuo', clientId: 'client-B' },
    ]);
  });

  it('cics vacío → array vacío, SIN llamar a findMany', async () => {
    const repo = new PrismaContractServiceRepository();
    const rows = await repo.findActiveTvOwnersByCics('cat-tv', []);

    expect(rows).toEqual([]);
    expect(mockPrisma.contractService.findMany).not.toHaveBeenCalled();
  });
});
