import { PrismaUnitOfWork } from '@infrastructure/adapters/prisma/PrismaUnitOfWork';
import { PrismaInventoryMovementRepository } from '@infrastructure/adapters/prisma/PrismaInventoryMovementRepository';
import { PrismaInventoryAssetRepository } from '@infrastructure/adapters/prisma/PrismaInventoryAssetRepository';

/**
 * Fix Test-H1/DimA — PrismaUnitOfWork had ZERO unit tests. It is the prod
 * transaction boundary for the confirm/replace dual-write, so it must:
 *   1. Open a single `client.$transaction` and build tx-scoped repos bound to
 *      the SAME tx client (so every write joins one transaction).
 *   2. Propagate a throw from the callback (so `$transaction` rolls back).
 *
 * We inject a fake client whose `$transaction` runs the callback against a fake
 * tx — no real DB is touched.
 */
describe('PrismaUnitOfWork.runInTransaction', () => {
  function fakeClient() {
    const fakeTx = { __isTx: true };
    const txClient = {
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(fakeTx)),
    };
    return { txClient, fakeTx };
  }

  it('opens ONE $transaction and hands tx-scoped repos to the callback', async () => {
    const { txClient, fakeTx } = fakeClient();
    const uow = new PrismaUnitOfWork(txClient as never);

    const result = await uow.runInTransaction(async (repos) => {
      // The repo bag must be built — all five inventory repos present.
      expect(repos.suggestions).toBeDefined();
      expect(repos.inventory).toBeDefined();
      expect(repos.locations).toBeDefined();
      expect(repos.assets).toBeDefined();
      expect(repos.movements).toBeDefined();
      // The repos must be tx-scoped (bound to the SAME tx client), not the root
      // client. A tx-scoped movement repo runs directly on tx (no nested
      // $transaction): isTxScoped is true because the fakeTx has no $transaction.
      expect((repos.movements as PrismaInventoryMovementRepository)['isTxScoped']).toBe(true);
      // The asset repo holds the SAME tx client we handed in.
      expect((repos.assets as PrismaInventoryAssetRepository)['db']).toBe(fakeTx);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(txClient.$transaction).toHaveBeenCalledTimes(1);
  });

  it('propagates a throw from the callback (so the $transaction rolls back)', async () => {
    const { txClient } = fakeClient();
    const uow = new PrismaUnitOfWork(txClient as never);
    const boom = new Error('boom');

    await expect(
      uow.runInTransaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(txClient.$transaction).toHaveBeenCalledTimes(1);
  });
});
