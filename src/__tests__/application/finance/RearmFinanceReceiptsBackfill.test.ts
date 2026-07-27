import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { RearmFinanceReceiptsBackfill } from '@application/use-cases/finance/RearmFinanceReceiptsBackfill';
import { FinanceSyncLockBusyError } from '@domain/errors/finance';

const BACKFILL_ENTITY = 'finance-receipts-backfill';

/**
 * fix-wave-1 F9 — the spec says a `done` backfill stays a no-op "hasta que se
 * re-arme", but no re-arm existed: `ForceFinanceDeltaRun` only ever touches
 * the delta lane, and `SyncGrReceiptsBackfillBatch` treats `cursor: null` as
 * permanently disarmed with zero GR calls. This aggravates F3 (a backfill
 * that self-disarmed on GR's own HTTP-200 errors had NO recovery path via the
 * API at all). This use case resets the cursor to the CURRENT month so the
 * backfill lane starts walking backward again on the next tick.
 */
describe('RearmFinanceReceiptsBackfill', () => {
  it('resets a DISARMED backfill (cursor: null, done) to the current month, offset 0', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: null, lastRunAt: new Date('2026-07-01T00:00:00Z'), lastResult: 'done', itemsSynced: 500000 });
    const uc = new RearmFinanceReceiptsBackfill(state, new InMemoryDistributedLock(), () => new Date('2026-07-15T12:00:00Z'), { retryDelayMs: 0 });

    const result = await uc.execute();

    expect(result).toEqual({ rearmed: true, cursor: '2026-07:0' });
    const saved = await state.get(BACKFILL_ENTITY);
    expect(saved?.cursor).toBe('2026-07:0');
    expect(saved?.lastResult).toBe('rearmed');
  });

  it('preserves the cumulative itemsSynced counter across the re-arm (history is not thrown away)', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: null, lastRunAt: new Date(), lastResult: 'done', itemsSynced: 500000 });
    const uc = new RearmFinanceReceiptsBackfill(state, new InMemoryDistributedLock(), () => new Date('2026-07-15T12:00:00Z'), { retryDelayMs: 0 });

    await uc.execute();

    const saved = await state.get(BACKFILL_ENTITY);
    expect(saved?.itemsSynced).toBe(500000);
  });

  it('also works when there is NO prior row at all (first-ever manual arm)', async () => {
    const state = new InMemorySyncStateRepository();
    const uc = new RearmFinanceReceiptsBackfill(state, new InMemoryDistributedLock(), () => new Date('2026-07-15T12:00:00Z'), { retryDelayMs: 0 });

    const result = await uc.execute();

    expect(result).toEqual({ rearmed: true, cursor: '2026-07:0' });
    const saved = await state.get(BACKFILL_ENTITY);
    expect(saved?.itemsSynced).toBe(0);
  });

  it('also re-arms a backfill that is mid-month (not just a fully-disarmed one) — an explicit restart, not just a recovery tool', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: '2026-02:5000', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 300000 });
    const uc = new RearmFinanceReceiptsBackfill(state, new InMemoryDistributedLock(), () => new Date('2026-07-15T12:00:00Z'), { retryDelayMs: 0 });

    const result = await uc.execute();

    expect(result.cursor).toBe('2026-07:0');
  });

  it('releases the lock after a successful write', async () => {
    const state = new InMemorySyncStateRepository();
    const lock = new InMemoryDistributedLock();
    const uc = new RearmFinanceReceiptsBackfill(state, lock, () => new Date('2026-07-15T12:00:00Z'), { retryDelayMs: 0 });

    await uc.execute();

    expect(lock.heldKeys.has('finance-receipts-ingest')).toBe(false);
  });

  // ── fix-wave-3 R10 — UNLIKE ForceFinanceDeltaRun, this lock IS load-bearing
  // (this method and a concurrent tick write the SAME `cursor` column), so it
  // still refuses to write unlocked — but now throws the typed
  // `FinanceSyncLockBusyError` (mapped to HTTP 503 + `Retry-After` by
  // `errorHandler`), not a bare `Error` that fell through to a generic 500.
  it('throws FinanceSyncLockBusyError (never writes unlocked) when the lock stays unavailable for the whole retry budget', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: '2019-06:0', lastRunAt: new Date('2026-07-15T10:00:00Z'), lastResult: 'batch ok', itemsSynced: 40 });
    const lock = new InMemoryDistributedLock();
    lock.forceAcquireFails = true;
    const uc = new RearmFinanceReceiptsBackfill(state, lock, () => new Date('2026-07-15T12:00:00Z'), { maxLockAttempts: 3, retryDelayMs: 0 });

    await expect(uc.execute()).rejects.toBeInstanceOf(FinanceSyncLockBusyError);

    const saved = await state.get(BACKFILL_ENTITY);
    expect(saved?.cursor).toBe('2019-06:0'); // completely untouched
  });

  it('the thrown FinanceSyncLockBusyError carries a retryAfterSeconds the route can surface as a header', async () => {
    const state = new InMemorySyncStateRepository();
    const lock = new InMemoryDistributedLock();
    lock.forceAcquireFails = true;
    const uc = new RearmFinanceReceiptsBackfill(state, lock, () => new Date('2026-07-15T12:00:00Z'), {
      maxLockAttempts: 2,
      retryDelayMs: 0,
      retryAfterSeconds: 5,
    });

    try {
      await uc.execute();
      throw new Error('expected uc.execute() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FinanceSyncLockBusyError);
      expect((err as FinanceSyncLockBusyError).retryAfterSeconds).toBe(5);
      expect((err as FinanceSyncLockBusyError).code).toBe('FINANCE_SYNC_LOCK_BUSY');
    }
  });

  // ── fix-wave-2 R6 — the concurrency probe reproducing the exact reported
  // scenario: a backfill tick mid-walk at `2019-06:0` reads that cursor,
  // spends the MEASURED GR latency fetching (holdMs), and only THEN does its
  // own end-of-run read-modify-write advancing to the PREVIOUS month. A
  // re-arm request that arrives WHILE the tick is in flight must not be lost
  // to that tick's own later write — it must land strictly AFTER it.
  describe('concurrency: a tick in flight must not lose the re-arm, and the re-arm must not be lost to it', () => {
    // fix-wave-3 R10 — bumped from fix-wave-2's 300ms. The re-review measured
    // that a tick does NOT release this lock when the GR fetch returns: it
    // holds it through 4 `$transaction`s (receipt/application/item/retención
    // upserts) PLUS N `invoiceTypes.upsertIfAbsent` calls — a REALISTIC hold
    // is plausibly 2-3s, not the fetch-only ~1.2s fix-wave-2 measured. 300ms
    // was "chosen to stay comfortably under the budget" — i.e. too small to
    // ever exercise the actual failure mode R10 reports. 2500ms stays under
    // fix-wave-3's DEFAULT budget (40 x 100ms = 4000ms) while being close to
    // the upper end of the realistic hold — using DEFAULT options on the
    // re-arm (no override) is what actually exercises the real budget.
    const HOLD_MS = 2500;

    async function simulateInFlightBackfillTick(
      state: InMemorySyncStateRepository,
      lock: InMemoryDistributedLock,
      holdMs: number,
    ): Promise<void> {
      const acquired = await lock.tryAcquire('finance-receipts-ingest');
      expect(acquired).toBe(true); // the tick starts FIRST, uncontested
      try {
        const prior = await state.get(BACKFILL_ENTITY);
        // Simulate the GR fetch + persistence latency.
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        // The tick's own full-row read-modify-write — advances the cursor to
        // the PREVIOUS month, exactly like SyncGrReceiptsBackfillBatch.execute()
        // does at the end of a page that exhausts the month, computed from
        // the STALE `prior` read at the START of the tick.
        void prior; // (the real use case derives the next cursor from `prior`; irrelevant to the probe)
        await state.save({
          entity: BACKFILL_ENTITY,
          cursor: '2019-05:0', // advanced PAST what it read — oblivious to any concurrent re-arm
          lastRunAt: new Date('2026-07-15T12:00:00Z'),
          lastResult: 'month ok @2019-06',
          itemsSynced: (prior?.itemsSynced ?? 0) + 100,
        });
      } finally {
        await lock.release('finance-receipts-ingest');
      }
    }

    it('the re-arm lands AFTER the in-flight tick releases the lock — its cursor wins, never rewound back to the tick\'s own advance', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      await state.save({ entity: BACKFILL_ENTITY, cursor: '2019-06:0', lastRunAt: new Date('2026-07-15T10:00:00Z'), lastResult: 'batch ok', itemsSynced: 40 });

      const rearm = new RearmFinanceReceiptsBackfill(state, lock, () => new Date('2026-07-15T12:00:00Z')); // DEFAULT budget

      const tickPromise = simulateInFlightBackfillTick(state, lock, HOLD_MS);
      await new Promise((resolve) => setTimeout(resolve, 5)); // let the tick acquire the lock FIRST
      const rearmPromise = rearm.execute();

      const [, rearmResult] = await Promise.all([tickPromise, rearmPromise]);

      expect(rearmResult).toEqual({ rearmed: true, cursor: '2026-07:0' });
      const saved = await state.get(BACKFILL_ENTITY);
      // The original bug: the tick's own write (based on a stale pre-rearm
      // read) landed AFTER the re-arm and silently overwrote it back to
      // '2019-05:0'. With the fix, the re-arm is strictly ordered AFTER the
      // tick (it waited out the SAME lock), so its cursor wins.
      expect(saved?.cursor).toBe('2026-07:0');
      expect(saved?.lastResult).toBe('rearmed');
      // itemsSynced is the tick's own targeted-untouched value — the re-arm
      // NEVER reads or rewrites it (targeted update), so the tick's own
      // cumulative advance survives intact.
      expect(saved?.itemsSynced).toBe(140);
    });
  });
});
