/**
 * gigared-tv-cic-reuse (T2.3) — adapter intention test con Prisma mockeado
 * (patrón `PrismaContractPairingReader.where.test.ts`).
 *
 * Lo que se fija acá es que las TRES condiciones de la invariante viajan en UNA sola query,
 * no resueltas por separado en la capa de aplicación: separarlas abre una ventana TOCTOU
 * entre "está dado de baja" y "no tiene fila activa".
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: { client: { findFirst: jest.fn() } },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaTvCicReuseEligibilityRepository } from '../../infrastructure/adapters/prisma/PrismaTvCicReuseEligibilityRepository';

const mockPrisma = prisma as unknown as { client: { findFirst: jest.Mock } };

const GUILLEN = 'bb25d17b-4770-48e3-9686-d9d9929e1898';

describe('gigared-tv-cic-reuse T2.3 — PrismaTvCicReuseEligibilityRepository', () => {
  let repo: PrismaTvCicReuseEligibilityRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PrismaTvCicReuseEligibilityRepository();
  });

  it('fila encontrada → true; fila null → false', async () => {
    mockPrisma.client.findFirst.mockResolvedValueOnce({ id: GUILLEN });
    await expect(repo.isEligibleForCicReuse(GUILLEN)).resolves.toBe(true);

    mockPrisma.client.findFirst.mockResolvedValueOnce(null);
    await expect(repo.isEligibleForCicReuse(GUILLEN)).resolves.toBe(false);
  });

  it('UNA sola query — las 3 condiciones no se resuelven por separado (anti-TOCTOU)', async () => {
    mockPrisma.client.findFirst.mockResolvedValueOnce(null);
    await repo.isEligibleForCicReuse(GUILLEN);
    expect(mockPrisma.client.findFirst).toHaveBeenCalledTimes(1);
  });

  it('el where lleva las 3 condiciones: id + tvCancelledAt NOT NULL + sin fila TV activa', async () => {
    mockPrisma.client.findFirst.mockResolvedValueOnce(null);
    await repo.isEligibleForCicReuse(GUILLEN);

    const arg = mockPrisma.client.findFirst.mock.calls[0][0];

    // 1. el cliente pedido, no cualquiera
    expect(arg.where.id).toBe(GUILLEN);

    // 2. baja de TV local
    expect(arg.where.tvCancelledAt).toEqual({ not: null });

    // 3. NINGÚN contrato con una fila de TV activa. `none` es load-bearing: con `some`
    //    invertido o con `every` el predicado significaría lo contrario.
    expect(arg.where.contracts).toEqual({
      none: {
        contractServices: {
          some: { status: 'active', serviceCatalog: { name: 'TV' } },
        },
      },
    });
  });

  it('proyecta sólo el id — no arrastra la fila entera del cliente', async () => {
    mockPrisma.client.findFirst.mockResolvedValueOnce(null);
    await repo.isEligibleForCicReuse(GUILLEN);
    expect(mockPrisma.client.findFirst.mock.calls[0][0].select).toEqual({ id: true });
  });
});
