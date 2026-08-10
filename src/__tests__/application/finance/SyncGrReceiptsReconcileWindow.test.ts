import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemoryFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinanceReceiptRetencionRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptRetencionRepository';
import { SyncGrReceiptsReconcileWindow, RECONCILE_ENTITY } from '@application/use-cases/finance/SyncGrReceiptsReconcileWindow';
import { readSnapshotRebuildQueue } from '@application/use-cases/finance/financeSnapshotRebuildQueue';
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

  // ── fix-wave RF13 — the sweep ends YESTERDAY, not today. A window whose
  // upper bound is "today" keeps growing WHILE the sweep paginates: GR's
  // `total` for `[desde, hoy]` changes every time a receipt is confirmed
  // during the sweep, so the offsets the cursor is walking stop meaning what
  // they meant when the sweep started (receipts shift between pages — some
  // read twice, some skipped). Ending at yesterday freezes the result set for
  // real. Nothing is lost: TODAY is exactly what the delta lane covers, every
  // `deltaCheckIntervalMs`.
  it('the first sweep computes the window as [yesterday-(windowDays-1), YESTERDAY] and starts at offset 0 — today belongs to the delta lane', async () => {
    const { gr, syncConfig, uc } = makeHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.receipts.push(receipt('R1', '05-07-2026')); // inside the 35-day window ending 09-08-2026

    await uc.execute();

    expect(gr.receiptsCalls).toHaveLength(1);
    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '06-07-2026', fechaHasta: '09-08-2026', offset: 0 });
  });

  it('TODAY is never inside the reconcile window — the result set cannot grow underneath a paginating sweep', async () => {
    const { gr, syncConfig, uc } = makeHarness(100, () => new Date('2026-08-10T14:00:00Z'));
    await syncConfig.update({ reconcileWindowDays: 35 });

    await uc.execute();

    expect(gr.receiptsCalls[0].fechaHasta).not.toBe('10-08-2026');
  });

  // ── task 4.2/8.7 (design.md Decision 7) — the normalizer's protection must
  // reach the USE CASE transparently: `reconcileWindowDays=0` "forzado en
  // DB" (here: written via the same `update()` an operator's raw SQL would
  // eventually flow through) still makes `execute()` request a REAL 35-day
  // window, never an empty/inerte one. This is the end-to-end proof that
  // `syncConfig.get()` — not just the normalizer in isolation — is what the
  // use case actually consults.
  it('reconcileWindowDays=0 forced past the normalizer still makes the use case request a REAL 35-day window (never an inert one)', async () => {
    const { gr, syncConfig, uc } = makeHarness();
    await syncConfig.update({ reconcileWindowDays: 0 });

    await uc.execute();

    expect(gr.receiptsCalls).toHaveLength(1);
    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '06-07-2026', fechaHasta: '09-08-2026', offset: 0 });
  });

  it('a receipt inside the window is upserted', async () => {
    const { gr, receipts, syncConfig, uc } = makeHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.receipts.push(receipt('R1', '08-07-2026')); // window is [06-07-2026, 09-08-2026]

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
    expect(saved?.cursor).toBe('06-07-2026:09-08-2026:2');
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
    expect(first.windowTo).toBe('09-08-2026');

    // Advance the clock PAST AR midnight (now 01-08-11 AR).
    now = new Date('2026-08-11T05:00:00Z'); // 02:00 AR on the 11th
    const second = await uc.execute();

    // Same sweep, page 2 — the window must NOT have re-derived from `now()`.
    expect(second.windowTo).toBe('09-08-2026');
    const saved = await state.get(RECONCILE_ENTITY);
    expect(saved?.cursor).toBe('06-07-2026:09-08-2026:4');
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

    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '06-07-2026', fechaHasta: '09-08-2026', offset: 0 });
  });

  // ── fix-wave RF4 — before this, a guard abort pinned the cursor: the SAME
  // page was re-requested on every tick where the lane was due, forever,
  // with no backoff and no escape. A GR drift that trips the guard on page 3
  // of a sweep froze the reconcile lane on page 3 permanently (and, since a
  // pending-pages cursor makes the lane ALWAYS due, it kept spending GR calls
  // to fail identically every time). Three consecutive aborts within the same
  // sweep now ABANDON the sweep: cursor → null, `lastRunAt` = now, so the next
  // attempt happens on the normal 6 h cadence, from scratch.
  describe('RF4: consecutive guard aborts abandon the sweep instead of pinning the cursor forever', () => {
    /** A page whose receipts are overwhelmingly annulled (unparseable residue) — trips the systemic guard. */
    function residueReceipt(id: string, dateDDMMYYYY: string): GrReceipt {
      return { ...receipt(id, dateDDMMYYYY), fechaAnulacion: 'basura' };
    }

    function seedGuardTrippingPage(gr: InMemoryGestionRealPort) {
      for (let i = 0; i < 20; i++) gr.receipts.push(residueReceipt(`G${i}`, '08-07-2026'));
    }

    it('the first two aborts KEEP the cursor pinned (the page is genuinely worth retrying)', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      seedGuardTrippingPage(gr);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      const afterFirst = await state.get(RECONCILE_ENTITY);
      expect(afterFirst?.cursor).toBe('06-07-2026:09-08-2026:0');

      now.v = new Date('2026-08-10T21:00:00Z');
      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      const afterSecond = await state.get(RECONCILE_ENTITY);
      expect(afterSecond?.cursor).toBe('06-07-2026:09-08-2026:0');
      errSpy.mockRestore();
    });

    it('the THIRD consecutive abort abandons the sweep: cursor → null, lastRunAt = now, degraded lastResult preserved', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      seedGuardTrippingPage(gr);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      for (const t of ['2026-08-10T14:00:00Z', '2026-08-10T21:00:00Z', '2026-08-11T04:00:00Z']) {
        now.v = new Date(t);
        await expect(uc.execute()).rejects.toThrow(/ABORT/);
      }
      errSpy.mockRestore();

      const saved = await state.get(RECONCILE_ENTITY);
      expect(saved?.cursor).toBeNull();
      expect(saved?.lastRunAt).toEqual(new Date('2026-08-11T04:00:00Z'));
      expect(saved?.lastResult).toMatch(/^error:/);
      expect(saved?.lastResult).toMatch(/ABORT/);
    });

    it('after abandoning, the very next tick makes ZERO GR calls (the cadence rules again — no more hammering the same page)', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35, reconcileCheckIntervalMs: 21600000 });
      seedGuardTrippingPage(gr);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      for (const t of ['2026-08-10T14:00:00Z', '2026-08-10T21:00:00Z', '2026-08-11T04:00:00Z']) {
        now.v = new Date(t);
        await expect(uc.execute()).rejects.toThrow(/ABORT/);
      }
      const callsAfterAbandon = gr.receiptsCalls.length;
      expect(callsAfterAbandon).toBe(3);

      // A 4th tick a minute later: the sweep is closed and the cadence has NOT
      // elapsed → the lane must not touch GR at all.
      now.v = new Date('2026-08-11T04:01:00Z');
      const result = await uc.execute();
      errSpy.mockRestore();

      expect(gr.receiptsCalls).toHaveLength(callsAfterAbandon);
      expect(result.pageProcessed).toBe(0);
    });

    it('once the cadence elapses, a fresh sweep starts FROM SCRATCH (offset 0, recomputed window)', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35, reconcileCheckIntervalMs: 21600000 });
      seedGuardTrippingPage(gr);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      for (const t of ['2026-08-10T14:00:00Z', '2026-08-10T21:00:00Z', '2026-08-11T04:00:00Z']) {
        now.v = new Date(t);
        await expect(uc.execute()).rejects.toThrow(/ABORT/);
      }

      // 7 h later (> 6 h cadence): GR has been fixed, the page is healthy now.
      gr.receipts.length = 0;
      gr.receipts.push(receipt('OK1', '08-07-2026'));
      now.v = new Date('2026-08-11T11:00:00Z');
      const result = await uc.execute();
      errSpy.mockRestore();

      expect(gr.receiptsCalls[gr.receiptsCalls.length - 1]).toMatchObject({ fechaDesde: '07-07-2026', fechaHasta: '10-08-2026', offset: 0 });
      expect(result.pageProcessed).toBe(1);
    });

    it('a SUCCESSFUL page in between resets the abort streak — three aborts must be CONSECUTIVE', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      seedGuardTrippingPage(gr);
      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      now.v = new Date('2026-08-10T21:00:00Z');
      await expect(uc.execute()).rejects.toThrow(/ABORT/);

      // A healthy sweep lands in between.
      gr.receipts.length = 0;
      gr.receipts.push(receipt('OK1', '08-07-2026'));
      now.v = new Date('2026-08-11T04:00:00Z');
      await uc.execute();

      // Two MORE aborts must NOT abandon (streak restarted at 1, then 2).
      gr.receipts.length = 0;
      seedGuardTrippingPage(gr);
      now.v = new Date('2026-08-11T11:00:00Z');
      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      now.v = new Date('2026-08-11T18:00:00Z');
      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      errSpy.mockRestore();

      const saved = await state.get(RECONCILE_ENTITY);
      expect(saved?.cursor).not.toBeNull();
    });

    // ── fix-wave-2 RFX3 — the streak used to be DERIVED by regex-ing the
    // previous `lastResult`. Any other failure written in between (an
    // `ECONNRESET` on the GR call, a repo write blowing up) overwrites that
    // string and the counter silently restarts at 1. A flaky GR — the exact
    // situation where the guard trips and the connection drops — could then
    // alternate abort/error/abort/error forever WITHOUT ever reaching three,
    // which is precisely the hammering RF4 exists to stop. The counter is now
    // persisted EXPLICITLY, incremented only by guard aborts, and it survives
    // whatever else gets written to `lastResult` in between.
    it('RFX3: an ECONNRESET between two aborts does NOT reset the streak — the third abort still abandons', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      seedGuardTrippingPage(gr);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const realFetch = gr.fetchReceipts.bind(gr);
      let broken = false;
      jest.spyOn(gr, 'fetchReceipts').mockImplementation(async (params) => {
        if (broken) throw new Error('ECONNRESET');
        return realFetch(params);
      });

      // abort, ECONNRESET, abort, ECONNRESET, abort — the same sweep
      // throughout (every failure re-pins the same composite cursor).
      const script: Array<{ at: string; fail: boolean }> = [
        { at: '2026-08-10T14:00:00Z', fail: false },
        { at: '2026-08-10T15:00:00Z', fail: true },
        { at: '2026-08-10T16:00:00Z', fail: false },
        { at: '2026-08-10T17:00:00Z', fail: true },
        { at: '2026-08-10T18:00:00Z', fail: false },
      ];
      for (const step of script) {
        now.v = new Date(step.at);
        broken = step.fail;
        await expect(uc.execute()).rejects.toThrow(step.fail ? /ECONNRESET/ : /ABORT/);
      }
      errSpy.mockRestore();

      const saved = await state.get(RECONCILE_ENTITY);
      expect(saved?.cursor).toBeNull();
      expect(saved?.lastResult).toMatch(/ABANDONADO/);
    });

    it('RFX3: the counter resets on abandonment — the FRESH sweep gets its own three attempts', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35, reconcileCheckIntervalMs: 21600000 });
      seedGuardTrippingPage(gr);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      for (const t of ['2026-08-10T14:00:00Z', '2026-08-10T21:00:00Z', '2026-08-11T04:00:00Z']) {
        now.v = new Date(t);
        await expect(uc.execute()).rejects.toThrow(/ABORT/);
      }
      expect((await state.get(RECONCILE_ENTITY))?.cursor).toBeNull();

      // Two aborts on the NEW sweep must NOT abandon it immediately.
      now.v = new Date('2026-08-11T11:00:00Z');
      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      now.v = new Date('2026-08-11T18:00:00Z');
      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      errSpy.mockRestore();

      expect((await state.get(RECONCILE_ENTITY))?.cursor).not.toBeNull();
    });

    it('a NON-guard failure (GR down) is unaffected — it still pins the cursor for a plain retry', async () => {
      const now = new Date('2026-08-10T14:00:00Z');
      const { gr, state, syncConfig, uc } = makeHarness(100, () => now);
      await syncConfig.update({ reconcileWindowDays: 35 });
      jest.spyOn(gr, 'fetchReceipts').mockRejectedValue(new Error('GR down'));

      for (let i = 0; i < 4; i++) await expect(uc.execute()).rejects.toThrow(/GR down/);

      const saved = await state.get(RECONCILE_ENTITY);
      expect(saved?.cursor).toBe('06-07-2026:09-08-2026:0');
    });
  });

  // ── fix-wave-2, re-lectura conjunta RFX1 × RF4 — the rebuild queue is
  // written by `persistReceiptPage`, and RF4 can ABANDON a sweep. Two
  // questions the two fixes raise together, answered here instead of by
  // reasoning: (a) can a guard abort leave an ORPHAN queued month (a month
  // queued for a page whose flip was never written)? and (b) does abandoning a
  // sweep LOSE months queued by pages that already succeeded?
  describe('RFX1 × RF4: the enqueue sits downstream of the guard, and survives an abandoned sweep', () => {
    /** now = 10-02-2026 → a 35-day window covers 06-01..09-02, so January receipts are in range. */
    const FEB = { v: new Date('2026-02-10T14:00:00Z') };
    const JAN_RECEIPT_DATE = '15-01-2026';

    function annulledResidue(id: string): GrReceipt {
      return { ...receipt(id, JAN_RECEIPT_DATE), fechaAnulacion: 'basura' };
    }

    async function mirrorAsLive(receipts: InMemoryFinancePaymentReceiptRepository, id: string): Promise<void> {
      await receipts.upsertBatch([
        {
          grReceiptId: id,
          clientGrId: '100011',
          recaudador: 'mercadopago',
          fechaRecibo: new Date('2026-01-15T13:00:00.000Z'),
          fechaConfirmacion: null,
          anulado: false,
          observaciones: null,
        },
      ]);
    }

    it('(a) a page the guard ABORTS queues nothing — the enqueue runs inside persistReceiptPage, which the abort never reaches', async () => {
      const now = { v: new Date(FEB.v) };
      const { gr, state, receipts, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      await mirrorAsLive(receipts, 'OLD1');
      // OLD1 would be a flip on 2026-01 (a closed month) — but the page is
      // poisoned, so NOTHING about it may be believed, queue included.
      gr.receipts.push(annulledResidue('OLD1'));
      for (let i = 0; i < 20; i++) gr.receipts.push(annulledResidue(`G${i}`));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      errSpy.mockRestore();

      expect(await readSnapshotRebuildQueue(state)).toEqual([]);
      expect(receipts.rows.get('OLD1')?.anulado).toBe(false);
    });

    it('(b) a month queued by a page that SUCCEEDED survives the sweep being abandoned three pages later', async () => {
      const now = { v: new Date(FEB.v) };
      const { gr, state, receipts, syncConfig, uc } = makeHarness(5, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      await mirrorAsLive(receipts, 'OLD1');

      // Page 1 (offset 0): ONE real annulment among five — under the minCount
      // floor of 5, so the guard lets it through and the flip is written.
      gr.receipts.push({ ...receipt('OLD1', JAN_RECEIPT_DATE), fechaAnulacion: '09-02-2026 10:00:00' });
      for (let i = 0; i < 4; i++) gr.receipts.push(receipt(`H${i}`, JAN_RECEIPT_DATE));
      // Page 2 (offset 5): all annulled residue — trips the guard, every time.
      for (let i = 0; i < 5; i++) gr.receipts.push(annulledResidue(`G${i}`));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await uc.execute();
      expect(receipts.rows.get('OLD1')?.anulado).toBe(true);
      expect(await readSnapshotRebuildQueue(state)).toEqual(['2026-01']);

      for (const t of ['2026-02-10T15:00:00Z', '2026-02-10T16:00:00Z', '2026-02-10T17:00:00Z']) {
        now.v = new Date(t);
        await expect(uc.execute()).rejects.toThrow(/ABORT/);
      }
      warnSpy.mockRestore();
      errSpy.mockRestore();

      // The sweep is gone; the repair it already earned is NOT.
      expect((await state.get(RECONCILE_ENTITY))?.cursor).toBeNull();
      expect(await readSnapshotRebuildQueue(state)).toEqual(['2026-01']);
    });
  });

  // ── fix-wave RF10 — `existingIds` is consulted to produce the "nuevos="
  // metric that makes the reconcile window's dimensioning falsifiable. Nothing
  // pinned that the result is actually CONSUMED: computing `nuevos` as the
  // whole page (ignoring the lookup) passed the entire suite, and the metric
  // would have read "everything is new" every sweep forever.
  describe('RF10: the "nuevos=" metric actually consumes existingIds', () => {
    it('the FIRST sweep reports every receipt as nuevo', async () => {
      const { gr, syncConfig, uc } = makeHarness();
      await syncConfig.update({ reconcileWindowDays: 35 });
      gr.receipts.push(receipt('N1', '08-07-2026'), receipt('N2', '09-07-2026'));
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await uc.execute();
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('nuevos='));
      logSpy.mockRestore();

      expect(line).toContain('nuevos=2');
    });

    it('a SECOND sweep over the same receipts reports nuevos=0 — the mirror already had them', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      gr.receipts.push(receipt('N1', '08-07-2026'), receipt('N2', '09-07-2026'));
      await uc.execute();

      now.v = new Date('2026-08-10T21:00:00Z');
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await uc.execute();
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('nuevos='));
      logSpy.mockRestore();

      expect(line).toContain('nuevos=0');
    });

    it('a mixed page counts ONLY the ones the mirror lacked', async () => {
      const now = { v: new Date('2026-08-10T14:00:00Z') };
      const { gr, syncConfig, uc } = makeHarness(100, () => now.v);
      await syncConfig.update({ reconcileWindowDays: 35 });
      gr.receipts.push(receipt('N1', '08-07-2026'));
      await uc.execute();

      gr.receipts.push(receipt('N2', '09-07-2026'), receipt('N3', '10-07-2026'));
      now.v = new Date('2026-08-10T21:00:00Z');
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await uc.execute();
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('nuevos='));
      logSpy.mockRestore();

      expect(line).toContain('nuevos=2');
    });
  });

  // ── fix-wave RF2/RF11 — the guard's thresholds must come from the LIVE DB
  // config on EVERY lane. See the twin tests in `SyncGrReceiptsDelta.test.ts`
  // and `SyncGrReceiptsBackfillBatch.test.ts`: the delta lane used to run the
  // guard against hardcoded defaults, so this pin exists on all three or it
  // proves nothing about "los tres carriles".
  describe('RF2: the annulment-guard thresholds are LIVE config, not hardcoded defaults', () => {
    function annulled(id: string, dateDDMMYYYY: string): GrReceipt {
      return { ...receipt(id, dateDDMMYYYY), fechaAnulacion: dateDDMMYYYY + ' 12:00:00' };
    }

    /** 20 receipts inside the window, 6 annulled = 30% — well over the 5% default. */
    function seedPage(gr: InMemoryGestionRealPort) {
      for (let i = 0; i < 6; i++) gr.receipts.push(annulled('A' + i, '08-07-2026'));
      for (let i = 0; i < 14; i++) gr.receipts.push(receipt('H' + i, '08-07-2026'));
    }

    it('30% annulled ABORTS under the default 5% threshold (baseline)', async () => {
      const { gr, syncConfig, uc } = makeHarness();
      await syncConfig.update({ reconcileWindowDays: 35 });
      seedPage(gr);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(uc.execute()).rejects.toThrow(/ABORT/);
      errSpy.mockRestore();
    });

    it('the SAME 30% page persists once the operator raises annulmentGuardMaxPct to 50 — the knob is alive', async () => {
      const { gr, receipts, syncConfig, uc } = makeHarness();
      await syncConfig.update({ reconcileWindowDays: 35, annulmentGuardMaxPct: 50 });
      seedPage(gr);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await uc.execute();
      warnSpy.mockRestore();

      expect(result.pageProcessed).toBe(20);
      expect(receipts.rows.size).toBe(20);
    });

    it('raising annulmentGuardMinCount above the page\'s annulled count also stops the abort — both knobs are read live', async () => {
      const { gr, receipts, syncConfig, uc } = makeHarness();
      await syncConfig.update({ reconcileWindowDays: 35, annulmentGuardMinCount: 50 });
      seedPage(gr);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await uc.execute();
      warnSpy.mockRestore();

      expect(result.pageProcessed).toBe(20);
      expect(receipts.rows.size).toBe(20);
    });
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
