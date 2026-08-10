import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemoryFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinanceReceiptRetencionRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptRetencionRepository';
import { SyncGrReceiptsReconcileWindow, RECONCILE_ENTITY } from '@application/use-cases/finance/SyncGrReceiptsReconcileWindow';
import { GrReceipt } from '@domain/entities/gestionReal';

function receipt(id: string, dateDDMMYYYY: string): GrReceipt {
  return {
    grReceiptId: id,
    clienteGrId: '100011',
    recaudador: 'mercadopago',
    fechaRecibo: `${dateDDMMYYYY} 10:00:00`,
    fechaConfirmacion: null,
    fechaAnulacion: null,
    observaciones: null,
    applications: [{ grApplicationId: `${id}-a1`, tipo: 'FB', sucursal: '00010', numero: id, importe: 1000, fecha: dateDDMMYYYY }],
  };
}

function makeHarness(pageSize = 100, now: () => Date = () => new Date('2026-08-10T14:00:00Z')) {
  const gr = new InMemoryGestionRealPort();
  const state = new InMemorySyncStateRepository();
  const receipts = new InMemoryFinancePaymentReceiptRepository();
  const applications = new InMemoryFinanceReceiptApplicationRepository();
  const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
  const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
  const items = new InMemoryFinanceReceiptItemRepository();
  const retenciones = new InMemoryFinanceReceiptRetencionRepository();
  const uc = new SyncGrReceiptsReconcileWindow(gr, state, receipts, applications, invoiceTypes, syncConfig, items, retenciones, { pageSize, now });
  return { gr, state, receipts, applications, invoiceTypes, syncConfig, items, retenciones, uc };
}

describe('SyncGrReceiptsReconcileWindow', () => {
  // ── design.md Decision 8 — same R9 criterion as delta/backfill: itemRepo/
  // retencionRepo are MANDATORY, never optional-and-trailing.
  describe('R9: itemRepo/retencionRepo are MANDATORY — construction throws if either is missing', () => {
    it('throws when itemRepo is missing', () => {
      expect(() => new SyncGrReceiptsReconcileWindow(
        new InMemoryGestionRealPort(),
        new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        undefined as never,
        new InMemoryFinanceReceiptRetencionRepository(),
      )).toThrow(/itemRepo and retencionRepo are REQUIRED/);
    });

    it('throws when retencionRepo is missing', () => {
      expect(() => new SyncGrReceiptsReconcileWindow(
        new InMemoryGestionRealPort(),
        new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        undefined as never,
      )).toThrow(/itemRepo and retencionRepo are REQUIRED/);
    });

    it('does NOT throw when both are provided', () => {
      expect(() => new SyncGrReceiptsReconcileWindow(
        new InMemoryGestionRealPort(),
        new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
      )).not.toThrow();
    });
  });

  it('the first sweep computes the window as [today-(windowDays-1), today] and starts at offset 0', async () => {
    const { gr, syncConfig, uc } = makeHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.receipts.push(receipt('R1', '05-07-2026')); // inside the 35-day window ending 10-08-2026

    await uc.execute();

    expect(gr.receiptsCalls).toHaveLength(1);
    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '07-07-2026', fechaHasta: '10-08-2026', offset: 0 });
  });

  it('a receipt inside the window is upserted', async () => {
    const { gr, receipts, syncConfig, uc } = makeHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.receipts.push(receipt('R1', '08-07-2026')); // window is [07-07-2026, 10-08-2026]

    await uc.execute();

    expect(receipts.rows.has('R1')).toBe(true);
  });

  it('paginates: a window with more receipts than pageSize keeps the cursor composite (sweepInProgress)', async () => {
    const { gr, state, syncConfig, uc } = makeHarness(2);
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.receipts.push(receipt('R1', '08-07-2026'), receipt('R2', '09-07-2026'), receipt('R3', '10-07-2026'));

    const result = await uc.execute();

    expect(result.sweepInProgress).toBe(true);
    const saved = await state.get(RECONCILE_ENTITY);
    expect(saved?.cursor).toBe('07-07-2026:10-08-2026:2');
  });

  it('the window is FROZEN across pages of the SAME sweep — a clock crossing AR midnight mid-sweep does not shift fechaHasta', async () => {
    let now = new Date('2026-08-10T23:50:00Z'); // 20:50 AR (UTC-3), still 10-08 AR
    const { gr, state, uc } = await (async () => {
      const h = makeHarness(2, () => now);
      await h.syncConfig.update({ reconcileWindowDays: 35 });
      return h;
    })();
    gr.receipts.push(
      receipt('R1', '08-07-2026'),
      receipt('R2', '09-07-2026'),
      receipt('R3', '10-07-2026'),
      receipt('R4', '11-07-2026'),
      receipt('R5', '12-07-2026'),
    );

    const first = await uc.execute();
    expect(first.windowTo).toBe('10-08-2026');

    // Advance the clock PAST AR midnight (now 01-08-11 AR).
    now = new Date('2026-08-11T05:00:00Z'); // 02:00 AR on the 11th
    const second = await uc.execute();

    // Same sweep, page 2 — the window must NOT have re-derived from `now()`.
    expect(second.windowTo).toBe('10-08-2026');
    const saved = await state.get(RECONCILE_ENTITY);
    expect(saved?.cursor).toBe('07-07-2026:10-08-2026:4');
  });

  it('a sweep that fits within one page closes to cursor: null, lastResult starting with "sweep ok"', async () => {
    const { gr, state, syncConfig, uc } = makeHarness(100);
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.receipts.push(receipt('R1', '08-07-2026'));

    const result = await uc.execute();

    expect(result.sweepInProgress).toBe(false);
    const saved = await state.get(RECONCILE_ENTITY);
    expect(saved?.cursor).toBeNull();
    expect(saved?.lastResult).toMatch(/^sweep ok/);
  });

  describe('cadencia — isReconcileDue', () => {
    it('a closed sweep (cursor: null) whose reconcileCheckIntervalMs has NOT elapsed is a no-op — zero GR calls', async () => {
      const now = new Date('2026-08-10T14:00:00Z');
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now);
      await syncConfig.update({ reconcileWindowDays: 35, reconcileCheckIntervalMs: 21600000 });
      await state.save({ entity: RECONCILE_ENTITY, cursor: null, lastRunAt: new Date('2026-08-10T13:00:00Z'), lastResult: 'sweep ok', itemsSynced: 5 });

      const result = await uc.execute();

      expect(gr.receiptsCalls).toHaveLength(0);
      expect(result.pageProcessed).toBe(0);
    });

    it('a closed sweep whose reconcileCheckIntervalMs HAS elapsed starts a fresh sweep', async () => {
      const now = new Date('2026-08-10T20:00:00Z');
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now);
      await syncConfig.update({ reconcileWindowDays: 35, reconcileCheckIntervalMs: 21600000 }); // 6h
      await state.save({ entity: RECONCILE_ENTITY, cursor: null, lastRunAt: new Date('2026-08-10T13:00:00Z'), lastResult: 'sweep ok', itemsSynced: 5 });

      await uc.execute();

      expect(gr.receiptsCalls).toHaveLength(1);
    });
  });

  it('a corrupt cursor recalculates the window from scratch (never re-derives a garbage GR range)', async () => {
    const { gr, state, syncConfig, uc } = makeHarness(100);
    await syncConfig.update({ reconcileWindowDays: 35 });
    await state.save({ entity: RECONCILE_ENTITY, cursor: 'garbage:not-a-date:abc', lastRunAt: new Date('2026-08-10T13:00:00Z'), lastResult: 'error: x', itemsSynced: 0 });
    gr.receipts.push(receipt('R1', '08-07-2026'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await uc.execute();
    warnSpy.mockRestore();

    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '07-07-2026', fechaHasta: '10-08-2026', offset: 0 });
  });

  it('reconcileEnabled: false results in ZERO calls to GR', async () => {
    const { gr, syncConfig, uc } = makeHarness();
    await syncConfig.update({ reconcileEnabled: false });
    gr.receipts.push(receipt('R1', '08-07-2026'));

    const result = await uc.execute();

    expect(gr.receiptsCalls).toHaveLength(0);
    expect(result.pageProcessed).toBe(0);
  });
});
