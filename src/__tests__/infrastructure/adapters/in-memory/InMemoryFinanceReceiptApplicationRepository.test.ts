import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';

/**
 * fix-wave-1 F13 — `listByClientAndMonth` needs the sibling receipts repo to
 * resolve `clientGrId` (same as the real schema's FK relation). Before the
 * fix, omitting it silently returned `[]` — a self-confirming mock hidden in
 * the adapter: a Fase 3 attribution test that forgets to thread the receipts
 * repo would assert "atribución = $0" and pass, hiding a REAL attribution bug.
 */
describe('InMemoryFinanceReceiptApplicationRepository — F13 noisy divergence', () => {
  it('listByClientAndMonth THROWS when constructed without the sibling receipts repo (never silently [])', async () => {
    const repo = new InMemoryFinanceReceiptApplicationRepository();
    await repo.upsertBatch([
      { grApplicationId: 'A1', receiptId: 'R1', grInvoiceId: 'FB-1-1', grType: 'FB', amount: 100, appliedDate: new Date('2026-06-15T03:00:00Z') },
    ]);

    await expect(repo.listByClientAndMonth('100011', '2026-06')).rejects.toThrow(/receipts repo/i);
  });

  it('listByClientAndMonth resolves normally when the sibling receipts repo IS wired', async () => {
    const receipts = new InMemoryFinancePaymentReceiptRepository();
    await receipts.upsertBatch([
      { grReceiptId: 'R1', clientGrId: '100011', recaudador: 'mercadopago', fechaRecibo: null, fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    const repo = new InMemoryFinanceReceiptApplicationRepository(receipts);
    await repo.upsertBatch([
      { grApplicationId: 'A1', receiptId: 'R1', grInvoiceId: 'FB-1-1', grType: 'FB', amount: 100, appliedDate: new Date('2026-06-15T03:00:00Z') },
    ]);

    const rows = await repo.listByClientAndMonth('100011', '2026-06');

    expect(rows).toHaveLength(1);
  });

  it('listByMonth still works without the sibling repo (only client-scoped lookup needs it)', async () => {
    const repo = new InMemoryFinanceReceiptApplicationRepository();
    await repo.upsertBatch([
      { grApplicationId: 'A1', receiptId: 'R1', grInvoiceId: 'FB-1-1', grType: 'FB', amount: 100, appliedDate: new Date('2026-06-15T03:00:00Z') },
    ]);

    const rows = await repo.listByMonth('2026-06');

    expect(rows).toHaveLength(1);
  });
});
