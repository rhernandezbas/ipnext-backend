import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';

/**
 * gr-receipt-annulment (design.md Decision 9) — `existingIds` backs the
 * reconcile lane's "nuevos=" observability metric (which of a page's ids the
 * mirror already had BEFORE this sweep persisted it) — a batched Set lookup,
 * never N.
 */
describe('InMemoryFinancePaymentReceiptRepository.existingIds', () => {
  it('returns only the ids that already exist, as a Set', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([
      { grReceiptId: 'R1', clientGrId: '1', recaudador: null, fechaRecibo: null, fechaConfirmacion: null, anulado: false, observaciones: null },
      { grReceiptId: 'R2', clientGrId: '1', recaudador: null, fechaRecibo: null, fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);

    const result = await repo.existingIds(['R1', 'R2', 'R3']);

    expect(result).toEqual(new Set(['R1', 'R2']));
  });

  it('an empty mirror returns an empty Set (no false positives)', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    expect(await repo.existingIds(['R1', 'R2'])).toEqual(new Set());
  });

  it('an empty query list returns an empty Set without throwing', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([{ grReceiptId: 'R1', clientGrId: '1', recaudador: null, fechaRecibo: null, fechaConfirmacion: null, anulado: false, observaciones: null }]);
    expect(await repo.existingIds([])).toEqual(new Set());
  });
});
