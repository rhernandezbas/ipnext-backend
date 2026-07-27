import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';

/**
 * fix-wave-3 LOW (read-path asymmetry) — `FinanceReceiptItem` (the CASH base
 * of the growth metric, spec.md) was write-only (`upsertBatch` and nothing
 * else) while `FinanceReceiptApplicationRepository` (debt CANCELLED, not
 * cash — R1's exact distinction) already exposed `listByMonth`/
 * `listByClientAndMonth`.
 *
 * fix-wave-4 W2 — the fix-wave-3 read path cut by THIS item's own `fecha`,
 * which is WRONG: measured live (500 recibos, junio 2026), 56/499 items
 * (10,4% of the cash) have NO `fecha` at all on the wire, and even when
 * present it can land in a DIFFERENT month than the receipt (measured: 29-05
 * vs recibo 01-06). The correct cut is the PARENT RECEIPT's `fechaRecibo`.
 * Fixtures below reflect the REAL payload shape (`fecha: null` for the
 * "missing key" case — `mapGrReceipt` already normalizes an absent wire key
 * to `null` before this repo ever sees it) instead of fix-wave-3's fixture,
 * which gave every item a `fecha` and made the in-memory double
 * self-confirming against its own (equally wrong) filter.
 */
describe('InMemoryFinanceReceiptItemRepository — read path (fix-wave-4 W2: cut by receipt.fechaRecibo)', () => {
  it('listByMonth returns an item with NO fecha at all (payload real: la clave no existe) when its RECEIPT falls in the given month', async () => {
    const receipts = new InMemoryFinancePaymentReceiptRepository();
    await receipts.upsertBatch([
      { grReceiptId: 'R1', clientGrId: '100011', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-01T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    const repo = new InMemoryFinanceReceiptItemRepository(receipts);
    await repo.upsertBatch([
      { grItemId: 'I1', receiptId: 'R1', banco: null, cajaCuentaId: null, destino: null, fecha: null, amount: 1200, moneda: 'PES', numeroTransferencia: null, tipo: null },
    ]);

    const rows = await repo.listByMonth('2026-06');

    // Under the old `item.fecha` cut this item vanished from EVERY month —
    // no error, no warning, just silently absent (~10,4% of live cash).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.grItemId).toBe('I1');
  });

  it('an item whose OWN fecha falls in a DIFFERENT month than its receipt is counted under the RECEIPT\'s month, not its own', async () => {
    const receipts = new InMemoryFinancePaymentReceiptRepository();
    await receipts.upsertBatch([
      { grReceiptId: 'R2', clientGrId: '100022', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-01T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    const repo = new InMemoryFinanceReceiptItemRepository(receipts);
    await repo.upsertBatch([
      // Measured live: item.fecha=29-05 on a recibo whose fecha_recibo=01-06.
      { grItemId: 'I2', receiptId: 'R2', banco: null, cajaCuentaId: null, destino: null, fecha: new Date('2026-05-29T03:00:00Z'), amount: 700, moneda: 'PES', numeroTransferencia: null, tipo: null },
    ]);

    const june = await repo.listByMonth('2026-06');
    const may = await repo.listByMonth('2026-05');

    expect(june.map((i) => i.grItemId)).toEqual(['I2']); // counted in the RECEIPT's month
    expect(may).toHaveLength(0); // NOT in item.fecha's own (wrong) month
  });

  it('listByMonth THROWS when constructed without the sibling receipts repo (never silently drop/miscount rows)', async () => {
    const repo = new InMemoryFinanceReceiptItemRepository();
    await repo.upsertBatch([
      { grItemId: 'I1', receiptId: 'R1', banco: null, cajaCuentaId: null, destino: null, fecha: new Date('2026-06-15T03:00:00Z'), amount: 1200, moneda: 'PES', numeroTransferencia: null, tipo: null },
    ]);

    await expect(repo.listByMonth('2026-06')).rejects.toThrow(/receipts repo/i);
  });

  it('listByClientAndMonth THROWS when constructed without the sibling receipts repo (never silently [])', async () => {
    const repo = new InMemoryFinanceReceiptItemRepository();
    await repo.upsertBatch([
      { grItemId: 'I1', receiptId: 'R1', banco: null, cajaCuentaId: null, destino: null, fecha: new Date('2026-06-15T03:00:00Z'), amount: 1200, moneda: 'PES', numeroTransferencia: null, tipo: null },
    ]);

    await expect(repo.listByClientAndMonth('100011', '2026-06')).rejects.toThrow(/receipts repo/i);
  });

  it('listByClientAndMonth resolves normally when the sibling receipts repo IS wired, cutting by fechaRecibo + clientGrId', async () => {
    const receipts = new InMemoryFinancePaymentReceiptRepository();
    await receipts.upsertBatch([
      { grReceiptId: 'R1', clientGrId: '100011', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-01T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
      { grReceiptId: 'R3', clientGrId: '999999', recaudador: 'mercadopago', fechaRecibo: new Date('2026-06-05T03:00:00Z'), fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);
    const repo = new InMemoryFinanceReceiptItemRepository(receipts);
    await repo.upsertBatch([
      { grItemId: 'I1', receiptId: 'R1', banco: null, cajaCuentaId: null, destino: null, fecha: null, amount: 1200, moneda: 'PES', numeroTransferencia: null, tipo: null },
      { grItemId: 'I3', receiptId: 'R3', banco: null, cajaCuentaId: null, destino: null, fecha: null, amount: 300, moneda: 'PES', numeroTransferencia: null, tipo: null },
    ]);

    const rows = await repo.listByClientAndMonth('100011', '2026-06');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(1200);
  });
});
