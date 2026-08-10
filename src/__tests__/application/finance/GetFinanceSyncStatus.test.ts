import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { GetFinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';

const BACKFILL_ENTITY = 'finance-receipts-backfill';

describe('GetFinanceSyncStatus', () => {
  it('a healthy composite cursor reports cursorYearMonth/cursorPageOffset correctly', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: '2026-03:1300', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 5000 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill.cursorYearMonth).toBe('2026-03');
    expect(status.backfill.cursorPageOffset).toBe(1300);
    expect(status.backfill.done).toBe(false);
  });

  // ── fix-wave-2 LOW (F14 residual) — this only validated `idx === -1`
  // (no `:` at all), NOT the `isValidYearMonth` shape. A truncated cursor
  // that the ingest use cases ALREADY treat as corrupt (and reset) would
  // still report a bogus `cursorYearMonth` here, contradicting their own
  // "sano" reset — /sync/status must agree with what the use cases actually do.
  it('F14 residual: a truncated yearMonth ("2026-0:5", NOT valid) reports cursorYearMonth as unknown (null), never the garbage substring', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: '2026-0:5', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 10 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill.cursorYearMonth).toBeNull();
    expect(status.backfill.cursorPageOffset).toBe(0);
  });

  it('a cursor with no ":" at all still reports cursorYearMonth as unknown (null) — pre-existing F14 behavior, unchanged', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: 'garbage', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 10 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill.cursorYearMonth).toBeNull();
  });

  // ── gr-receipt-annulment (design.md Decision 9) — the reconcile block,
  // same derive-from-SyncState convention as delta/backfill.
  describe('reconcile block', () => {
    const RECONCILE_ENTITY = 'finance-receipts-reconcile';

    it('a sweep in progress (composite cursor) reports windowFrom/windowTo/pageOffset and sweepInProgress:true', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:200', lastRunAt: new Date(), lastResult: 'page ok @200', itemsSynced: 200 });
      const uc = new GetFinanceSyncStatus(state);

      const status = await uc.execute();

      expect(status.reconcile.windowFrom).toBe('07-07-2026');
      expect(status.reconcile.windowTo).toBe('10-08-2026');
      expect(status.reconcile.pageOffset).toBe(200);
      expect(status.reconcile.sweepInProgress).toBe(true);
      expect(status.reconcile.itemsSynced).toBe(200);
    });

    it('a closed sweep (cursor: null) reports sweepInProgress:false and null window', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: RECONCILE_ENTITY, cursor: null, lastRunAt: new Date(), lastResult: 'sweep ok 07-07-2026..10-08-2026', itemsSynced: 5950 });
      const uc = new GetFinanceSyncStatus(state);

      const status = await uc.execute();

      expect(status.reconcile.sweepInProgress).toBe(false);
      expect(status.reconcile.windowFrom).toBeNull();
      expect(status.reconcile.windowTo).toBeNull();
      expect(status.reconcile.pageOffset).toBe(0);
      expect(status.reconcile.lastResult).toBe('sweep ok 07-07-2026..10-08-2026');
    });

    it('never ran (no SyncState row) reports all-null/zero defaults, never throws', async () => {
      const state = new InMemorySyncStateRepository();
      const uc = new GetFinanceSyncStatus(state);

      const status = await uc.execute();

      expect(status.reconcile.lastRunAt).toBeNull();
      expect(status.reconcile.lastResult).toBeNull();
      expect(status.reconcile.itemsSynced).toBe(0);
      expect(status.reconcile.sweepInProgress).toBe(false);
    });

    it('a corrupt composite cursor reports "unknown" (sweepInProgress:false, null window), same F14 criterion as backfill', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: RECONCILE_ENTITY, cursor: 'garbage:not-a-date:x', lastRunAt: new Date(), lastResult: 'error: x', itemsSynced: 0 });
      const uc = new GetFinanceSyncStatus(state);

      const status = await uc.execute();

      expect(status.reconcile.sweepInProgress).toBe(false);
      expect(status.reconcile.windowFrom).toBeNull();
      expect(status.reconcile.windowTo).toBeNull();
    });
  });
});
