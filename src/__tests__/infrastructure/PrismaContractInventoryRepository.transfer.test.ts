/**
 * service-transfer fix wave L1/L4 — paridad de INTENCIÓN del adapter Prisma para
 * `transferToContract` (mismo techo de cobertura que InventoryAdapterParity: el brazo Prisma
 * corre contra un cliente fake capturado, así que se asserta la query/args EXACTA que emite el
 * adapter — no un re-read de Postgres real; el repo no tiene pg-mem/testcontainer hoy).
 *
 * Contrato (espejo del InMemory, tests directos en InMemoryContractInventoryRepository.test.ts):
 *   - update CONDICIONAL: updateMany WHERE { id, status: 'active' } — mata la ventana del retire
 *     concurrente DENTRO de la tx (el repo corre tx-scoped vía PrismaClientLike en el UnitOfWork).
 *   - count 0 + fila inexistente  → InstalledItemNotFoundError
 *   - count 0 + fila no-active    → InstalledItemAlreadyRemovedError
 */
import { PrismaContractInventoryRepository } from '@infrastructure/adapters/prisma/PrismaContractInventoryRepository';
import type { PrismaClientLike } from '@infrastructure/adapters/prisma/PrismaClientLike';
import { InstalledItemNotFoundError, InstalledItemAlreadyRemovedError } from '@domain/errors/inventory';

function fakeDb(opts: { updateCount: number; existing: { status: string } | null }) {
  const updateManyCalls: Record<string, unknown>[] = [];
  const db = {
    contractInstalledItem: {
      updateMany: jest.fn(async (args: Record<string, unknown>) => {
        updateManyCalls.push(args);
        return { count: opts.updateCount };
      }),
      findUnique: jest.fn(async () => opts.existing),
    },
  } as unknown as PrismaClientLike;
  return { db, updateManyCalls };
}

describe('PrismaContractInventoryRepository.transferToContract — L1 update condicional', () => {
  it('emite un updateMany CONDICIONAL WHERE { id, status: "active" } con solo contractId en data', async () => {
    const { db, updateManyCalls } = fakeDb({ updateCount: 1, existing: null });
    await new PrismaContractInventoryRepository(db).transferToContract('it-1', 'C-B');
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0]).toEqual({
      where: { id: 'it-1', status: 'active' },
      data: { contractId: 'C-B' },
    });
  });

  it('count 0 + fila inexistente → InstalledItemNotFoundError (paridad InMemory)', async () => {
    const { db } = fakeDb({ updateCount: 0, existing: null });
    await expect(new PrismaContractInventoryRepository(db).transferToContract('ghost', 'C-B'))
      .rejects.toBeInstanceOf(InstalledItemNotFoundError);
  });

  it('count 0 + fila existente pero no-active → InstalledItemAlreadyRemovedError (el retire ganó la carrera)', async () => {
    const { db } = fakeDb({ updateCount: 0, existing: { status: 'removed' } });
    await expect(new PrismaContractInventoryRepository(db).transferToContract('it-1', 'C-B'))
      .rejects.toBeInstanceOf(InstalledItemAlreadyRemovedError);
  });
});
