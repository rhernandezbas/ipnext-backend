import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { ListFinanceInvoiceTypes } from '@application/use-cases/finance/ListFinanceInvoiceTypes';
import { ReclassifyFinanceInvoiceType } from '@application/use-cases/finance/ReclassifyFinanceInvoiceType';
import { GetFinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';
import { ForceFinanceDeltaRun } from '@application/use-cases/finance/ForceFinanceDeltaRun';

describe('ListFinanceInvoiceTypes', () => {
  it('lists all classifications, including unclassified', async () => {
    const repo = new InMemoryFinanceInvoiceTypeClassificationRepository();
    repo.seed('FB', 'revenue', 'Factura B');
    repo.seed('XZ', 'unclassified');

    const uc = new ListFinanceInvoiceTypes(repo);
    const result = await uc.execute();

    expect(result.map((r) => r.grType).sort()).toEqual(['FB', 'XZ']);
  });
});

describe('ReclassifyFinanceInvoiceType', () => {
  it('updates the bucket for a known grType', async () => {
    const repo = new InMemoryFinanceInvoiceTypeClassificationRepository();
    repo.seed('XZ', 'unclassified');
    const uc = new ReclassifyFinanceInvoiceType(repo);

    const result = await uc.execute('XZ', 'revenue');

    expect(result.bucket).toBe('revenue');
    expect((await repo.get('XZ'))?.bucket).toBe('revenue');
  });

  it('creates the row when reclassifying a grType never seen before', async () => {
    const repo = new InMemoryFinanceInvoiceTypeClassificationRepository();
    const uc = new ReclassifyFinanceInvoiceType(repo);

    const result = await uc.execute('NC', 'contra', 'Nota de crédito');

    expect(result).toMatchObject({ grType: 'NC', bucket: 'contra', label: 'Nota de crédito' });
  });
});

describe('ForceFinanceDeltaRun', () => {
  it('resets the delta lastRunAt so the next tick is immediately due, WITHOUT touching the cursor', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: new Date('2026-07-15T12:00:00Z'), lastResult: 'ok', itemsSynced: 5 });
    const uc = new ForceFinanceDeltaRun(state, new InMemoryDistributedLock());

    const result = await uc.execute();

    expect(result).toEqual({ started: true });
    const saved = await state.get('finance-receipts-delta');
    expect(saved?.lastRunAt).toBeNull();
    expect(saved?.cursor).toBe('15-07-2026'); // untouched
  });

  it('is a safe no-op-ish call when the delta never ran yet (no row)', async () => {
    const state = new InMemorySyncStateRepository();
    const uc = new ForceFinanceDeltaRun(state, new InMemoryDistributedLock());

    const result = await uc.execute();

    expect(result).toEqual({ started: true });
    expect(await state.get('finance-receipts-delta')).toBeNull();
  });

  it('never touches the backfill cursor', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
    await state.save({ entity: 'finance-receipts-backfill', cursor: '2026-03:200', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 300 });
    const uc = new ForceFinanceDeltaRun(state, new InMemoryDistributedLock());

    await uc.execute();

    const backfill = await state.get('finance-receipts-backfill');
    expect(backfill?.cursor).toBe('2026-03:200');
  });

  // ── F8 — read-modify-write without a lock can lose the button press OR
  // rewind the cursor when a scheduler tick is in flight concurrently. The
  // fix serializes against the SAME `finance-receipts-ingest` lock the
  // scheduler's tick() holds for its whole run.
  describe('F8: serialized against a concurrent tick via the shared lock', () => {
    it('acquires the SAME lock key the scheduler ticks use before touching SyncState', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
      const lock = new InMemoryDistributedLock();
      const tryAcquireSpy = jest.spyOn(lock, 'tryAcquire');
      const uc = new ForceFinanceDeltaRun(state, lock);

      await uc.execute();

      expect(tryAcquireSpy).toHaveBeenCalledWith('finance-receipts-ingest');
      expect(lock.heldKeys.has('finance-receipts-ingest')).toBe(false); // released after
    });

    it('when the lock is held by an in-flight tick, it retries instead of racing a read-modify-write', async () => {
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
      const lock = new InMemoryDistributedLock();
      let attempts = 0;
      jest.spyOn(lock, 'tryAcquire').mockImplementation(async () => {
        attempts++;
        return attempts >= 3; // fails twice (tick "in flight"), then the tick finishes and releases
      });
      const uc = new ForceFinanceDeltaRun(state, lock, { retryDelayMs: 0 });

      const result = await uc.execute();

      expect(result).toEqual({ started: true });
      expect(attempts).toBeGreaterThanOrEqual(3);
      const saved = await state.get('finance-receipts-delta');
      expect(saved?.lastRunAt).toBeNull();
    });

    // ── fix-wave-3 R10 — supersedes fix-wave-2 R2's "never write unlocked"
    // stance for THIS use case: R2's own docblock already proves the write is
    // safe in EITHER order against a concurrent tick (targeted single-column
    // update), so the lock here is defense-in-depth, not load-bearing. The
    // re-review measured `POST /sync/run` 500ing on ~10-15% of requests at
    // normal pacing because the budget was sized to GR's fetch latency alone,
    // not the tick's TOTAL hold (4 transactions + N upserts, ~2-3s). Trading
    // an always-safe write for a customer-visible 500 was strictly worse than
    // proceeding — see `ForceFinanceDeltaRun.test.ts` for the full probe.
    it('proceeds WITHOUT the lock (best-effort) when the retry budget is exhausted — the targeted write is safe unlocked', async () => {
      const state = new InMemorySyncStateRepository();
      const priorLastRunAt = new Date('2026-07-15T12:00:00Z');
      await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: priorLastRunAt, lastResult: 'ok', itemsSynced: 1 });
      const lock = new InMemoryDistributedLock();
      lock.forceAcquireFails = true; // the lock NEVER frees up within the retry budget
      const uc = new ForceFinanceDeltaRun(state, lock, { maxLockAttempts: 3, retryDelayMs: 0 });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await uc.execute();

      expect(result).toEqual({ started: true });
      const saved = await state.get('finance-receipts-delta');
      expect(saved?.lastRunAt).toBeNull(); // the write happened, unlocked
      expect(saved?.cursor).toBe('15-07-2026'); // targeted update — untouched
      expect(saved?.itemsSynced).toBe(1);
      warnSpy.mockRestore();
    });
  });
});

describe('GetFinanceSyncStatus', () => {
  it('derives pendingPages/coveredThroughDate for the delta lane', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'finance-receipts-delta', cursor: '10-07-2026:15-07-2026:20', lastRunAt: new Date('2026-07-15T12:00:00Z'), lastResult: 'page ok', itemsSynced: 20 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.delta.pendingPages).toBe(true);
    expect(status.delta.coveredThroughDate).toBeNull();
    expect(status.delta.itemsSynced).toBe(20);
  });

  it('derives coveredThroughDate for a fully-covered delta cursor', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'finance-receipts-delta', cursor: '15-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.delta.pendingPages).toBe(false);
    expect(status.delta.coveredThroughDate).toBe('15-07-2026');
  });

  it('derives cursorYearMonth/cursorPageOffset for an in-progress backfill', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'finance-receipts-backfill', cursor: '2026-03:1300', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 5000 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill).toMatchObject({ cursorYearMonth: '2026-03', cursorPageOffset: 1300, done: false, itemsSynced: 5000 });
  });

  it('reports backfill done when the cursor is null (and a row exists)', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'finance-receipts-backfill', cursor: null, lastRunAt: new Date(), lastResult: 'done', itemsSynced: 300000 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill).toMatchObject({ done: true, cursorYearMonth: null, cursorPageOffset: 0 });
  });

  // F14 — GetFinanceSyncStatus repeats the same unvalidated lastIndexOf split;
  // a corrupt cursor with no ':' at all must report "unknown", never garbage
  // sliced off the raw string (e.g. "2026-0" or "202").
  it('F14: a corrupt cursor with no ":" reports cursorYearMonth null instead of garbage', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'finance-receipts-backfill', cursor: 'garbage', lastRunAt: new Date(), lastResult: 'batch ok', itemsSynced: 5 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill.cursorYearMonth).toBeNull();
    expect(status.backfill.cursorPageOffset).toBe(0);
  });

  it('reports backfill NOT done (never started) when no row exists yet', async () => {
    const state = new InMemorySyncStateRepository();
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill).toMatchObject({ done: false, cursorYearMonth: null, cursorPageOffset: 0, lastRunAt: null });
  });

  it('surfaces gr-debtor-balances state untouched', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: 'gr-debtor-balances', cursor: null, lastRunAt: new Date('2026-07-15T03:00:00Z'), lastResult: 'ok', itemsSynced: 75 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.debtorBalances).toMatchObject({ lastResult: 'ok', itemsSynced: 75 });
  });
});
