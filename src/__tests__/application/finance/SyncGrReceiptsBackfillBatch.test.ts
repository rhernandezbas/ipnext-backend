import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemoryFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinanceReceiptRetencionRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptRetencionRepository';
import { SyncGrReceiptsBackfillBatch } from '@application/use-cases/finance/SyncGrReceiptsBackfillBatch';
import { FinanceReceiptPersistenceError } from '@application/use-cases/finance/financeIngestErrors';
import { GrReceipt } from '@domain/entities/gestionReal';

const ENTITY = 'finance-receipts-backfill';

function receipt(id: string, dateDDMMYYYY: string, grType = 'FB'): GrReceipt {
  return {
    grReceiptId: id,
    clienteGrId: '100011',
    recaudador: 'mercadopago',
    fechaRecibo: `${dateDDMMYYYY} 10:00:00`,
    fechaConfirmacion: null,
    fechaAnulacion: null,
    observaciones: null,
    applications: [
      { grApplicationId: `${id}-a1`, tipo: grType, sucursal: '00010', numero: id, importe: 1000, fecha: dateDDMMYYYY },
    ],
  };
}

function seedMonth(gr: InMemoryGestionRealPort, yearMonth: string, count: number, grType = 'FB'): void {
  const [y, m] = yearMonth.split('-');
  for (let i = 0; i < count; i++) {
    const day = String((i % 27) + 1).padStart(2, '0');
    gr.receipts.push(receipt(`${yearMonth}-${i}`, `${day}-${m}-${y}`, grType));
  }
}

function makeHarness(pageSize = 100) {
  const gr = new InMemoryGestionRealPort();
  const state = new InMemorySyncStateRepository();
  const receipts = new InMemoryFinancePaymentReceiptRepository();
  const applications = new InMemoryFinanceReceiptApplicationRepository();
  const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
  const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
  const items = new InMemoryFinanceReceiptItemRepository();
  const retenciones = new InMemoryFinanceReceiptRetencionRepository();
  const uc = new SyncGrReceiptsBackfillBatch(gr, state, receipts, applications, invoiceTypes, syncConfig, items, retenciones, { pageSize });
  return { gr, state, receipts, applications, invoiceTypes, syncConfig, items, retenciones, uc };
}

describe('SyncGrReceiptsBackfillBatch', () => {
  // ── fix-wave-3 R9 — same criterion as SyncGrReceiptsDelta: the constructor
  // throws if either the item or retención repo is missing, instead of
  // silently skipping their upserts.
  describe('R9: itemRepo/retencionRepo are MANDATORY — construction throws if either is missing', () => {
    it('throws when itemRepo is missing', () => {
      expect(() => new SyncGrReceiptsBackfillBatch(
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
      expect(() => new SyncGrReceiptsBackfillBatch(
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
      expect(() => new SyncGrReceiptsBackfillBatch(
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

  it('first run (no cursor) starts at the CURRENT calendar month, offset 0', async () => {
    const { gr, uc } = makeHarness(10);
    seedMonth(gr, '2026-07', 3);
    // No `now` override here — pin one explicitly via options instead.
    const { gr: gr2, uc: uc2 } = makeHarness(10);
    seedMonth(gr2, '2026-07', 3);
    const ucWithClock = new SyncGrReceiptsBackfillBatch(
      gr2,
      new InMemorySyncStateRepository(),
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
    );

    await ucWithClock.execute();

    expect(gr2.receiptsCalls).toHaveLength(1);
    expect(gr2.receiptsCalls[0]).toMatchObject({ fechaDesde: '01-07-2026', fechaHasta: '31-07-2026', offset: 0, cantidad: 10 });
    void gr; void uc;
  });

  it('execute() pages EXACTLY one GR page (never drains the rest of the month internally)', async () => {
    const { gr, uc } = makeHarness(10);
    seedMonth(gr, '2026-07', 25); // more than one page's worth
    const clock = () => new Date('2026-07-15T12:00:00Z');
    const ucClocked = new SyncGrReceiptsBackfillBatch(
      gr,
      new InMemorySyncStateRepository(),
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10, now: clock },
    );

    const result = await ucClocked.execute();

    expect(gr.receiptsCalls).toHaveLength(1);
    expect(result.pageProcessed).toBe(10);
    void uc;
  });

  it('a page that does NOT exhaust the month advances offset but keeps the same yearMonth', async () => {
    const state = new InMemorySyncStateRepository();
    const gr = new InMemoryGestionRealPort();
    seedMonth(gr, '2026-07', 25);
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
    );

    await uc.execute();

    const saved = await state.get(ENTITY);
    expect(saved?.cursor).toBe('2026-07:10');
  });

  it('the page that DOES exhaust the month advances the cursor to the PREVIOUS month, offset reset to 0', async () => {
    const state = new InMemorySyncStateRepository();
    const gr = new InMemoryGestionRealPort();
    seedMonth(gr, '2026-07', 5); // fewer than a page
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
    );

    const result = await uc.execute();

    const saved = await state.get(ENTITY);
    expect(saved?.cursor).toBe('2026-06:0');
    expect(result.monthAdvanced).toBe(true);
    expect(result.done).toBe(false);
  });

  it('resumability: a mid-month cursor retakes the SAME month at the SAME offset after a simulated restart', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: ENTITY, cursor: '2026-03:20', lastRunAt: null, lastResult: 'batch ok', itemsSynced: 20 });
    const gr = new InMemoryGestionRealPort();
    seedMonth(gr, '2026-03', 35);
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10 },
    );

    await uc.execute();

    expect(gr.receiptsCalls).toHaveLength(1);
    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '01-03-2026', fechaHasta: '31-03-2026', offset: 20 });
    const saved = await state.get(ENTITY);
    expect(saved?.cursor).toBe('2026-03:30');
  });

  it('reaching the configured floor and completing it marks done; the next run is a no-op', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: ENTITY, cursor: '2013-01:0', lastRunAt: null, lastResult: 'batch ok', itemsSynced: 0 });
    const gr = new InMemoryGestionRealPort();
    seedMonth(gr, '2013-01', 3); // fewer than a page → exhausts on first call
    const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
    await syncConfig.update({ backfillFloorYearMonth: '2013-01' });
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      syncConfig,
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10 },
    );

    const result = await uc.execute();

    expect(result.done).toBe(true);
    const saved = await state.get(ENTITY);
    expect(saved?.cursor).toBeNull();
    expect(saved?.lastResult).toBe('done');

    gr.receiptsCalls = [];
    const noop = await uc.execute();
    expect(noop).toMatchObject({ pageProcessed: 0, done: true });
    expect(gr.receiptsCalls).toHaveLength(0);
  });

  it('auto-classifies a never-seen grType as unclassified, without overwriting an already-classified one', async () => {
    const gr = new InMemoryGestionRealPort();
    seedMonth(gr, '2026-07', 2, 'FA');
    const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
    invoiceTypes.seed('FB', 'revenue', 'Factura B');
    // Add one FB-classified receipt too, to prove FB is untouched.
    gr.receipts.push(receipt('fb-extra', '05-07-2026', 'FB'));
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, new InMemorySyncStateRepository(),
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      invoiceTypes,
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
    );

    await uc.execute();

    const fa = await invoiceTypes.get('FA');
    expect(fa?.bucket).toBe('unclassified');
    const fb = await invoiceTypes.get('FB');
    expect(fb?.bucket).toBe('revenue');
    expect(fb?.label).toBe('Factura B');
  });

  it('persists receipts and applications for the page', async () => {
    const gr = new InMemoryGestionRealPort();
    seedMonth(gr, '2026-07', 3);
    const receiptsRepo = new InMemoryFinancePaymentReceiptRepository();
    const appsRepo = new InMemoryFinanceReceiptApplicationRepository(receiptsRepo);
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, new InMemorySyncStateRepository(),
      receiptsRepo, appsRepo,
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
    );

    const result = await uc.execute();

    expect(result.pageProcessed).toBe(3);
    expect(receiptsRepo.rows.size).toBe(3);
    expect(appsRepo.rows.size).toBe(3);
  });

  it('a page error is counted/logged; the cursor does NOT advance past the last successful page', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: ENTITY, cursor: '2026-05:40', lastRunAt: null, lastResult: 'batch ok', itemsSynced: 40 });
    const gr = new InMemoryGestionRealPort();
    gr.fetchReceipts = async () => {
      throw new Error('GR timeout');
    };
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10 },
    );

    await expect(uc.execute()).rejects.toThrow('GR timeout');

    const saved = await state.get(ENTITY);
    expect(saved?.cursor).toBe('2026-05:40');
    expect(saved?.lastResult).toMatch(/error:/);
  });

  // ── F5 — a PERSISTENCE failure must ALSO land in SyncState (not just a
  // GR-fetch failure). Before the fix, a throw from `upsertBatch`/
  // `upsertIfAbsent` escaped `execute()` UNCAUGHT — SyncState was never
  // touched, `lastRunAt` froze, and (combined with F4) the frozen
  // `finance-receipts-delta` state made the delta look "due" forever,
  // starving the backfill lane on every subsequent tick.
  describe('F5: persistence failures are recorded, not swallowed', () => {
    it('applicationRepo.upsertBatch throwing records lastResult: error: and does NOT advance the cursor', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: ENTITY, cursor: '2019-06:0', lastRunAt: null, lastResult: 'batch ok', itemsSynced: 0 });
      const gr = new InMemoryGestionRealPort();
      seedMonth(gr, '2019-06', 3);
      const applications = new InMemoryFinanceReceiptApplicationRepository();
      applications.upsertBatch = async () => {
        throw new Error('P2000: value too long for column importe');
      };
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, state,
        new InMemoryFinancePaymentReceiptRepository(),
        applications,
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10 },
      );

      await expect(uc.execute()).rejects.toThrow('P2000');

      const saved = await state.get(ENTITY);
      expect(saved?.lastResult).toMatch(/^error:/);
      expect(saved?.cursor).toBe('2019-06:0');
      expect(saved?.lastRunAt).not.toBeNull();
    });

    // ── fix-wave-3 R8 — same pinning as the delta lane's equivalent test:
    // the ERROR SHAPE must distinguish persistence from GR-fetch failures so
    // the scheduler's shared pacing backoff responds only to GR's own health.
    it('a persistence failure is thrown as FinanceReceiptPersistenceError', async () => {
      const gr = new InMemoryGestionRealPort();
      seedMonth(gr, '2026-07', 3);
      const applications = new InMemoryFinanceReceiptApplicationRepository();
      applications.upsertBatch = async () => {
        throw new Error('P2000: poisoned row');
      };
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        applications,
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
      );

      await expect(uc.execute()).rejects.toBeInstanceOf(FinanceReceiptPersistenceError);
    });

    it('a GR-fetch failure is NEVER wrapped as FinanceReceiptPersistenceError', async () => {
      const gr = new InMemoryGestionRealPort();
      gr.fetchReceipts = async () => {
        throw new Error('GR timeout');
      };
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
      );

      await expect(uc.execute()).rejects.not.toBeInstanceOf(FinanceReceiptPersistenceError);
    });
  });

  // ── F12 — a page requested within the reported range that parses to ZERO
  // receipts is suspicious; guard is `offset < total`, never `total > 0`
  // (measured: a legitimate empty tail page returns offset=900, total=828).
  describe('F12: suspicious empty-page warning', () => {
    it('warns when offset < total but the page parsed to zero receipts', async () => {
      const gr = new InMemoryGestionRealPort();
      gr.fetchReceipts = async () => ({ total: 5, receipts: [] });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
      );

      await uc.execute();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/suspicious empty page/i));
      warnSpy.mockRestore();
    });

    it('does NOT warn for a legitimate empty TAIL page (offset >= total)', async () => {
      const gr = new InMemoryGestionRealPort();
      gr.fetchReceipts = async () => ({ total: 0, receipts: [] });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
      );

      await uc.execute();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── F14 — a corrupted cursor resets to the current month instead of being
  // blindly derived into an invalid GR range via `lastIndexOf` arithmetic.
  describe('F14: corrupt cursor recovery', () => {
    it('a legacy flat "2026-03" cursor (misread as yearMonth="2026-0" by naive lastIndexOf) resets to the current month', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: ENTITY, cursor: '2026-03', lastRunAt: null, lastResult: 'batch ok', itemsSynced: 40 });
      const gr = new InMemoryGestionRealPort();
      seedMonth(gr, '2026-07', 3);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, state,
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
      );

      await uc.execute();

      expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '01-07-2026', fechaHasta: '31-07-2026', offset: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/corrupt/i));
      warnSpy.mockRestore();
    });

    // ── fix-wave-2 LOW (F14 residual) — `parseCursor`'s `Number(...) || 0`
    // silently folded ANY non-numeric or NEGATIVE offset down to `0` instead
    // of flagging the cursor as corrupt (same blind spot F14 already closed
    // for the delta lane's composite cursor).
    it('a cursor with a negative offset ("2026-07:-5") is treated as corrupt and resets to the current month', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: ENTITY, cursor: '2026-07:-5', lastRunAt: null, lastResult: 'batch ok', itemsSynced: 40 });
      const gr = new InMemoryGestionRealPort();
      seedMonth(gr, '2026-07', 3);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, state,
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
      );

      await uc.execute();

      expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '01-07-2026', fechaHasta: '31-07-2026', offset: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/corrupt/i));
      warnSpy.mockRestore();
    });

    it('a cursor with a non-numeric offset ("2026-07:garbage") is treated as corrupt and resets to the current month', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: ENTITY, cursor: '2026-07:garbage', lastRunAt: null, lastResult: 'batch ok', itemsSynced: 40 });
      const gr = new InMemoryGestionRealPort();
      seedMonth(gr, '2026-07', 3);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsBackfillBatch(
        gr, state,
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptSyncConfigRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 10, now: () => new Date('2026-07-15T12:00:00Z') },
      );

      await uc.execute();

      expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '01-07-2026', fechaHasta: '31-07-2026', offset: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/corrupt/i));
      warnSpy.mockRestore();
    });
  });

  it('not-armed no-op after done: disarmed (cursor null, previously done) returns done with zero GR calls', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: ENTITY, cursor: null, lastRunAt: new Date(), lastResult: 'done', itemsSynced: 500 });
    const gr = new InMemoryGestionRealPort();
    const uc = new SyncGrReceiptsBackfillBatch(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 10 },
    );

    const result = await uc.execute();

    expect(result).toMatchObject({ pageProcessed: 0, done: true });
    expect(gr.receiptsCalls).toHaveLength(0);
  });
});
