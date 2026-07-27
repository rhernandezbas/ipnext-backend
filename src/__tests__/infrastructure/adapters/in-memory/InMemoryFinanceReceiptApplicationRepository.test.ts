import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';

/**
 * finance-growth Fase 3 rework (F9) — `listByMonth`/`listByClientAndMonth`
 * now cut by the PARENT RECEIPT's `fechaRecibo`, NOT this application's own
 * nullable `appliedDate` (mirrors `InMemoryFinanceReceiptItemRepository`'s
 * fix-wave-4 W2 fix). Before this fix, an application with `appliedDate:
 * null` vanished from every month with no error — and since
 * `unclassifiedAmountArs` (the watchdog built specifically so misclassified
 * money never disappears silently) is fed by `listByMonth`, it inherited the
 * exact same blind spot it exists to catch.
 */
describe('InMemoryFinanceReceiptApplicationRepository — read path (F9: cut by receipt.fechaRecibo)', () => {
  it('listByMonth returns an application with appliedDate: null when its RECEIPT falls in the given month', async () => {
    const receipts = new InMemoryFinancePaymentReceiptRepository();
    await receipts.upsertBatch([
      { grReceiptId: 'R1', clientGrId: '100011', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-01T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    const repo = new InMemoryFinanceReceiptApplicationRepository(receipts);
    await repo.upsertBatch([
      { grApplicationId: 'A1', receiptId: 'R1', grInvoiceId: 'FB-1-1', grType: 'FB', amount: 900, appliedDate: null },
    ]);

    const rows = await repo.listByMonth('2026-06');

    // Under the OLD `appliedDate` cut this application vanished from EVERY
    // month — no error, no warning, and its amount never reached
    // unclassifiedAmountArs either (F9's exact scenario P1).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.grApplicationId).toBe('A1');
  });

  it('an application whose OWN appliedDate falls in a DIFFERENT month than its receipt is counted under the RECEIPT\'s month', async () => {
    const receipts = new InMemoryFinancePaymentReceiptRepository();
    await receipts.upsertBatch([
      { grReceiptId: 'R2', clientGrId: '100022', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-01T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    const repo = new InMemoryFinanceReceiptApplicationRepository(receipts);
    await repo.upsertBatch([
      { grApplicationId: 'A2', receiptId: 'R2', grInvoiceId: 'FB-2-2', grType: 'FB', amount: 700, appliedDate: new Date('2026-05-29T03:00:00Z') },
    ]);

    const june = await repo.listByMonth('2026-06');
    const may = await repo.listByMonth('2026-05');

    expect(june.map((a) => a.grApplicationId)).toEqual(['A2']);
    expect(may).toHaveLength(0);
  });

  it('listByMonth THROWS when constructed without the sibling receipts repo (never silently drop/miscount rows)', async () => {
    const repo = new InMemoryFinanceReceiptApplicationRepository();
    await repo.upsertBatch([
      { grApplicationId: 'A1', receiptId: 'R1', grInvoiceId: 'FB-1-1', grType: 'FB', amount: 100, appliedDate: new Date('2026-06-15T03:00:00Z') },
    ]);

    await expect(repo.listByMonth('2026-06')).rejects.toThrow(/receipts repo/i);
  });

  it('listByClientAndMonth THROWS when constructed without the sibling receipts repo (never silently [])', async () => {
    const repo = new InMemoryFinanceReceiptApplicationRepository();
    await repo.upsertBatch([
      { grApplicationId: 'A1', receiptId: 'R1', grInvoiceId: 'FB-1-1', grType: 'FB', amount: 100, appliedDate: new Date('2026-06-15T03:00:00Z') },
    ]);

    await expect(repo.listByClientAndMonth('100011', '2026-06')).rejects.toThrow(/receipts repo/i);
  });

  it('listByClientAndMonth resolves normally when the sibling receipts repo IS wired, cutting by fechaRecibo + clientGrId', async () => {
    const receipts = new InMemoryFinancePaymentReceiptRepository();
    await receipts.upsertBatch([
      { grReceiptId: 'R1', clientGrId: '100011', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-01T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
      { grReceiptId: 'R3', clientGrId: '999999', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-05T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    const repo = new InMemoryFinanceReceiptApplicationRepository(receipts);
    await repo.upsertBatch([
      { grApplicationId: 'A1', receiptId: 'R1', grInvoiceId: 'FB-1-1', grType: 'FB', amount: 1200, appliedDate: null },
      { grApplicationId: 'A3', receiptId: 'R3', grInvoiceId: 'FB-3-3', grType: 'FB', amount: 300, appliedDate: null },
    ]);

    const rows = await repo.listByClientAndMonth('100011', '2026-06');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(1200);
  });
});
