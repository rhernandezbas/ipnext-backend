import { FinanceReceiptIngestScheduler } from '@infrastructure/scheduling/FinanceReceiptIngestScheduler';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository';
import { FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { DeltaPageResult } from '@application/use-cases/finance/SyncGrReceiptsDelta';
import { BackfillPageResult } from '@application/use-cases/finance/SyncGrReceiptsBackfillBatch';
import { ReconcilePageResult } from '@application/use-cases/finance/SyncGrReceiptsReconcileWindow';
import { FinanceReceiptPersistenceError, FinanceReceiptAnnulmentGuardError } from '@application/use-cases/finance/financeIngestErrors';

const DELTA_ENTITY = 'finance-receipts-delta';
const RECONCILE_ENTITY = 'finance-receipts-reconcile';

function fakeDelta(result: DeltaPageResult | Error = { pageProcessed: 0, hasPendingPages: false, coveredThroughDate: null }) {
  return { execute: jest.fn(async () => { if (result instanceof Error) throw result; return result; }) };
}
function fakeBackfill(result: BackfillPageResult | Error = { pageProcessed: 0, monthAdvanced: false, done: true }) {
  return { execute: jest.fn(async () => { if (result instanceof Error) throw result; return result; }) };
}
// gr-receipt-annulment (design.md Decision 1) — third lane fake, molde fakeDelta/fakeBackfill.
function fakeReconcile(result: ReconcilePageResult | Error = { pageProcessed: 0, sweepInProgress: false, windowFrom: null, windowTo: null }) {
  return { execute: jest.fn(async () => { if (result instanceof Error) throw result; return result; }) };
}

function makeHarness(opts: {
  deltaCheckIntervalMs?: number;
  requestIntervalMs?: number;
  maxRequestIntervalMs?: number;
  enabled?: boolean;
  now?: () => Date;
} = {}) {
  const state = new InMemorySyncStateRepository();
  const lock = new InMemoryDistributedLock();
  const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
  const delta = fakeDelta();
  const backfill = fakeBackfill();
  const reconcile = fakeReconcile();
  // gr-receipt-annulment — reconcile defaults to "already satisfied" (a
  // closed sweep, just ran) so the ~30 PRE-EXISTING delta-vs-backfill tests
  // in this file (written before the third lane existed) keep their original
  // 2-lane semantics unless a test explicitly seeds RECONCILE_ENTITY itself
  // (the dedicated arbitration describe block below does exactly that).
  // Without this, `isReconcileDue`'s `!prior` branch makes reconcile due by
  // DEFAULT (never ran) in every one of those tests, silently stealing turns
  // that used to go to backfill. `InMemorySyncStateRepository.save` has no
  // internal `await`, so the Map write lands synchronously before this
  // function returns — safe to fire-and-forget in a non-async helper.
  void state.save({ entity: RECONCILE_ENTITY, cursor: null, lastRunAt: (opts.now ?? (() => new Date()))(), lastResult: 'sweep ok', itemsSynced: 0 });
  const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, reconcile as never, {
    silent: true,
    now: opts.now,
  });
  return { state, lock, syncConfig, delta, backfill, reconcile, scheduler, opts };
}

/** Seeds the config repo BEFORE constructing the harness's expectations — call before `scheduler.tick()`. */
async function seedConfig(
  syncConfig: InMemoryFinanceReceiptSyncConfigRepository,
  patch: {
    requestIntervalMs?: number;
    maxRequestIntervalMs?: number;
    deltaCheckIntervalMs?: number;
    enabled?: boolean;
    deltaStarvationThreshold?: number;
    reconcileEnabled?: boolean;
    reconcileCheckIntervalMs?: number;
  },
) {
  await syncConfig.update(patch);
}

describe('FinanceReceiptIngestScheduler', () => {
  it('the delta lane wins the tick when it has pending pages, even if backfill also has work', async () => {
    const { state, delta, backfill, scheduler, syncConfig } = makeHarness();
    await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
    await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:20', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 20 });

    const result = await scheduler.tick();

    expect(delta.execute).toHaveBeenCalledTimes(1);
    expect(backfill.execute).not.toHaveBeenCalled();
    expect(result.lane).toBe('delta');
  });

  it('backfill gets the turn when delta has no pending pages and deltaCheckIntervalMs has NOT elapsed', async () => {
    const now = new Date('2026-07-15T12:05:00Z');
    const { state, delta, backfill, scheduler, syncConfig } = makeHarness({ now: () => now });
    await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
    await state.save({ entity: DELTA_ENTITY, cursor: '15-07-2026', lastRunAt: new Date('2026-07-15T12:02:00Z'), lastResult: 'ok', itemsSynced: 1 });

    const result = await scheduler.tick();

    expect(backfill.execute).toHaveBeenCalledTimes(1);
    expect(delta.execute).not.toHaveBeenCalled();
    expect(result.lane).toBe('backfill');
  });

  it('the turn returns to delta once deltaCheckIntervalMs elapses (periodic "today" re-check)', async () => {
    const now = new Date('2026-07-15T12:10:00Z');
    const { state, delta, backfill, scheduler, syncConfig } = makeHarness({ now: () => now });
    await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
    await state.save({ entity: DELTA_ENTITY, cursor: '15-07-2026', lastRunAt: new Date('2026-07-15T12:02:00Z'), lastResult: 'ok', itemsSynced: 1 });

    const result = await scheduler.tick();

    expect(delta.execute).toHaveBeenCalledTimes(1);
    expect(backfill.execute).not.toHaveBeenCalled();
    expect(result.lane).toBe('delta');
  });

  it('a failed tick doubles effectiveIntervalMs (capped by maxRequestIntervalMs) and counts the failure', async () => {
    const { scheduler, syncConfig } = makeHarness();
    await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000 });
    (scheduler as unknown as { syncBackfill: { execute: jest.Mock } }).syncBackfill = fakeBackfill(new Error('GR down')) as never;
    (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;

    const r1 = await scheduler.tick();
    expect(r1.error).toBe('GR down');
    expect(scheduler.status.consecutiveFailures).toBe(1);
    expect(scheduler.status.effectiveIntervalMs).toBe(40000);
    expect(scheduler.status.degraded).toBe(true);

    const r2 = await scheduler.tick();
    expect(r2.error).toBe('GR down');
    expect(scheduler.status.consecutiveFailures).toBe(2);
    expect(scheduler.status.effectiveIntervalMs).toBe(80000);
  });

  it('the backoff is capped at maxRequestIntervalMs', async () => {
    const { scheduler, syncConfig } = makeHarness();
    await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 50000 });
    (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;

    await scheduler.tick(); // 40000
    await scheduler.tick(); // would be 80000, capped to 50000

    expect(scheduler.status.effectiveIntervalMs).toBe(50000);
  });

  it('the FIRST successful tick after degradation resets effectiveIntervalMs and consecutiveFailures immediately', async () => {
    const { scheduler, syncConfig } = makeHarness();
    await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000 });
    (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;
    await scheduler.tick();
    expect(scheduler.status.degraded).toBe(true);

    (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta() as never;
    await scheduler.tick();

    expect(scheduler.status.effectiveIntervalMs).toBe(20000);
    expect(scheduler.status.consecutiveFailures).toBe(0);
    expect(scheduler.status.degraded).toBe(false);
  });

  it('acquires the DistributedLock before each tick; a held lock is a no-op, NOT a failure (no backoff)', async () => {
    const { lock, delta, backfill, scheduler } = makeHarness();
    lock.forceAcquireFails = true;

    const result = await scheduler.tick();

    expect(result.skipped).toBe(true);
    expect(delta.execute).not.toHaveBeenCalled();
    expect(backfill.execute).not.toHaveBeenCalled();
    expect(scheduler.status.consecutiveFailures).toBe(0);
    expect(scheduler.status.degraded).toBe(false);
  });

  it('releases the lock after a tick (success or failure)', async () => {
    const { lock, scheduler } = makeHarness();
    await scheduler.tick();
    expect(lock.heldKeys.has('finance-receipts-ingest')).toBe(false);
  });

  // ── LOW — TOCTOU in the reentrancy guard. `if (this.inFlight)` was checked,
  // THEN `await lock.tryAcquire()` ran, and ONLY THEN was `inFlight` set true.
  // `PgAdvisoryLock` is RE-ENTRANT within the same DB connection/process (the
  // docblock's "two-layer guard" promise), so Layer 2 provides NO protection
  // against two ticks racing from the SAME process — this test uses a lock
  // double that always grants (mimicking that reentrancy) to isolate Layer 1
  // as the ONLY thing that must prevent a double-tick.
  it('sets the intra-process inFlight guard IMMEDIATELY (before any await) — a reentrant lock alone must not allow two concurrent ticks', async () => {
    const state = new InMemorySyncStateRepository();
    const alwaysGrantingLock = { tryAcquire: jest.fn(async () => true), release: jest.fn(async () => {}) };
    const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
    const delta = fakeDelta();
    const backfill = fakeBackfill();
    const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, alwaysGrantingLock as never, syncConfig, fakeReconcile() as never, { silent: true });

    const [r1, r2] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    const results = [r1, r2];
    const skippedCount = results.filter((r) => r.skipped).length;
    const ranCount = results.filter((r) => r.lane).length;

    expect(skippedCount).toBe(1);
    expect(ranCount).toBe(1);
    expect(delta.execute.mock.calls.length + backfill.execute.mock.calls.length).toBe(1);
  });

  // ── hueco de cobertura #8 — "backfill cede turno mientras el delta se pone
  // al día" tested with a SINGLE tick only; here across several consecutive ones.
  it('across several consecutive ticks, the delta keeps winning while it has pending pages, THEN backfill resumes', async () => {
    const { state, delta, backfill, scheduler, syncConfig } = makeHarness();
    await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
    await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:0', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 0 });

    // First 2 ticks: delta still paginating (pending pages persisted by the fake
    // resolving to hasPendingPages:true — the scheduler doesn't know or care,
    // it only reads SyncState, so we simulate the use case updating it).
    (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = {
      execute: jest.fn(async () => {
        await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:100', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 100 });
        return { pageProcessed: 100, hasPendingPages: true, coveredThroughDate: null };
      }),
    } as never;
    await scheduler.tick();
    await scheduler.tick();
    expect(delta.execute).not.toHaveBeenCalled(); // the replaced fake ran, not the original spy
    expect(backfill.execute).not.toHaveBeenCalled();

    // Range fully caught up now — cursor collapses to plain.
    await state.save({ entity: DELTA_ENTITY, cursor: '15-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 200 });
    const result = await scheduler.tick();

    expect(result.lane).toBe('backfill');
    expect(backfill.execute).toHaveBeenCalledTimes(1);
  });

  // ── F4 — the delta lane can no longer monopolize EVERY tick just by being
  // "due" once it has failed a sustained number of times in a row. Verified
  // with the REAL use cases + a real degraded repo in
  // `finance-receipts-ingest-seam.test.ts` (huecos de cobertura #4); this test
  // pins the scheduler's OWN arbitration logic in isolation.
  describe('F4: anti-starvation circuit breaker', () => {
    it('after 3 consecutive delta failures, the backfill lane starts getting turns even though the delta remains "due"', async () => {
      const { state, backfill, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      // Delta has a composite (pending-pages) cursor → ALWAYS "due", regardless of lastRunAt.
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:0', lastRunAt: new Date(), lastResult: 'error: GR down', itemsSynced: 0 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;

      // Ticks 1-3: delta still gets tried (streak building 1,2,3) and keeps failing.
      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();
      expect(backfill.execute).not.toHaveBeenCalled();

      // From here on, the circuit breaker must let backfill through periodically.
      let backfillRanAtLeastOnce = false;
      for (let i = 0; i < 10; i++) {
        const r = await scheduler.tick();
        if (r.lane === 'backfill') backfillRanAtLeastOnce = true;
      }

      expect(backfillRanAtLeastOnce).toBe(true);
      expect(backfill.execute.mock.calls.length).toBeGreaterThan(0);
    });

    it('normal operation (delta healthy) is UNCHANGED — delta keeps ABSOLUTE priority, streak never builds', async () => {
      const { state, delta, backfill, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:0', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 0 });
      // Delta always reports pending pages (never collapses in this test) but SUCCEEDS every time.
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta({ pageProcessed: 5, hasPendingPages: true, coveredThroughDate: null }) as never;

      for (let i = 0; i < 10; i++) {
        const r = await scheduler.tick();
        expect(r.lane).toBe('delta');
      }

      expect(backfill.execute).not.toHaveBeenCalled();
      expect(delta.execute).not.toHaveBeenCalled(); // replaced fake ran instead
    });

    it('a delta SUCCESS resets the failure streak — the circuit breaker closes again', async () => {
      const { state, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:0', lastRunAt: new Date(), lastResult: 'error: GR down', itemsSynced: 0 });
      const failingDelta = fakeDelta(new Error('GR down'));
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = failingDelta as never;

      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();
      // Recover: delta now succeeds and clears its pending-pages cursor. Swap
      // it in NOW — the very next tick may still land on an "even" (backfill)
      // slot of the alternation pattern, so keep ticking until delta is
      // actually attempted again (odd slot) to observe the recovery.
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = {
        execute: jest.fn(async () => {
          await state.save({ entity: DELTA_ENTITY, cursor: '15-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
          return { pageProcessed: 1, hasPendingPages: false, coveredThroughDate: '15-07-2026' };
        }),
      } as never;
      let recoveredOnLane: string | undefined;
      for (let i = 0; i < 4 && recoveredOnLane !== 'delta'; i++) {
        const r = await scheduler.tick();
        recoveredOnLane = r.lane;
      }
      expect(recoveredOnLane).toBe('delta');

      // Delta is no longer due (plain cursor, deltaCheckIntervalMs not elapsed) →
      // backfill gets the NEXT tick normally, not via the circuit breaker.
      const next = await scheduler.tick();
      expect(next.lane).toBe('backfill');
    });
  });

  // ── F6 — pacing/kill-switch config is read LIVE per tick, never frozen at
  // construction. `enabled=false` must actually stop GR calls at runtime.
  describe('F6: live config — no restart required', () => {
    it('a config change BETWEEN ticks changes the scheduled pacing without restarting the scheduler', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000 });
      await scheduler.tick();
      expect(scheduler.status.requestIntervalMs).toBe(20000);

      await seedConfig(syncConfig, { requestIntervalMs: 10000 });
      await scheduler.tick();

      expect(scheduler.status.requestIntervalMs).toBe(10000);
      expect(scheduler.status.effectiveIntervalMs).toBe(10000);
    });

    it('enabled=false is an EFFECTIVE runtime kill-switch — no GR calls, tick is skipped', async () => {
      const { delta, backfill, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { enabled: false });

      const result = await scheduler.tick();

      expect(result.skipped).toBe(true);
      expect(delta.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
    });

    it('flipping enabled back to true resumes ticking WITHOUT a restart', async () => {
      const { delta, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { enabled: false });
      await scheduler.tick();
      expect(delta.execute).not.toHaveBeenCalled();

      await seedConfig(syncConfig, { enabled: true });
      await scheduler.tick();

      expect(delta.execute).toHaveBeenCalledTimes(1);
    });

    it('a disabled tick does not perturb the backoff state', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { enabled: false });
      await scheduler.tick();
      expect(scheduler.status.consecutiveFailures).toBe(0);
      expect(scheduler.status.degraded).toBe(false);
    });
  });

  // ── F7 — stop() must actually stop the timer chain, even with a tick in flight.
  describe('F7: stop() halts the timer chain', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a tick already in flight when stop() is called does NOT re-schedule the next one', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ requestIntervalMs: 20000, deltaCheckIntervalMs: 300000 });

      let resolveDelta!: () => void;
      const inFlightDelta = new Promise<void>((resolve) => { resolveDelta = resolve; });
      const delta = { execute: jest.fn(async () => { await inFlightDelta; return { pageProcessed: 0, hasPendingPages: false, coveredThroughDate: null }; }) };
      const backfill = { execute: jest.fn(async () => ({ pageProcessed: 0, monthAdvanced: false, done: true })) };

      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      scheduler.start();
      // Let the FIRST tick start and get stuck awaiting `inFlightDelta`.
      await jest.advanceTimersByTimeAsync(20000);
      expect(delta.execute).toHaveBeenCalledTimes(1);

      scheduler.stop();
      // Now let the in-flight tick resolve — its `.finally()` tries to reschedule.
      resolveDelta();
      await jest.advanceTimersByTimeAsync(0);
      // Advance well past another interval — if `stop()` didn't actually stop
      // the chain, a second tick would fire here.
      await jest.advanceTimersByTimeAsync(60000);

      expect(delta.execute).toHaveBeenCalledTimes(1);
    });

    it('start() then stop() before any tick fires never calls either lane', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      scheduler.start();
      scheduler.stop();
      await jest.advanceTimersByTimeAsync(120000);

      expect(delta.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
    });
  });

  // ── fix-wave-2 LOW (timer bifurcation) — `scheduleNext()` must be the SOLE
  // owner of `this.timer`. Before this fix, overwriting `this.timer` WITHOUT
  // clearing whatever it previously pointed to let two independent timer
  // chains survive at once — each firing on its OWN cadence forever ⇒ 2× the
  // SHARED GR request budget, a direct violation of the user's LOCK decision
  // ("no saturar GR"). `stop()` alone doesn't catch this: it only clears
  // whatever `this.timer` points to AT THAT INSTANT, not a timer armed by a
  // LATER, independent `scheduleNext()` call.
  describe('LOW: scheduleNext never bifurcates into two live timer chains (2x GR budget)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('start() called twice arms only ONE live timer — a single tick per interval, not two', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ requestIntervalMs: 20000, deltaCheckIntervalMs: 300000 });
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      scheduler.start();
      scheduler.start(); // called again — must NOT create a second parallel timer chain

      await jest.advanceTimersByTimeAsync(20000);
      const firstWindowCalls = delta.execute.mock.calls.length + backfill.execute.mock.calls.length;
      await jest.advanceTimersByTimeAsync(20000);
      const secondWindowCalls = delta.execute.mock.calls.length + backfill.execute.mock.calls.length - firstWindowCalls;

      // A bifurcated pair of chains armed ~simultaneously by the double
      // start() would each land in the SAME 20s window and both execute
      // (the intra-process `inFlight` guard only blocks truly SIMULTANEOUS
      // overlapping ticks, not two chains ticking independently every 20s).
      expect(firstWindowCalls).toBe(1);
      expect(secondWindowCalls).toBe(1);
    });

    it('stop() then start() while a tick is in flight collapses to a SINGLE re-armed chain, not two independent ones', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ requestIntervalMs: 20000, deltaCheckIntervalMs: 300000 });

      let resolveDelta!: () => void;
      const inFlightDelta = new Promise<void>((resolve) => { resolveDelta = resolve; });
      const delta = { execute: jest.fn(async () => { await inFlightDelta; return { pageProcessed: 0, hasPendingPages: false, coveredThroughDate: null }; }) };
      const backfill = { execute: jest.fn(async () => ({ pageProcessed: 0, monthAdvanced: false, done: true })) };

      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      scheduler.start(); // arms chain A
      await jest.advanceTimersByTimeAsync(20000); // chain A fires -> tick 1 starts, stuck in-flight
      expect(delta.execute).toHaveBeenCalledTimes(1);

      scheduler.stop();
      scheduler.start(); // arms chain B EXPLICITLY, while tick 1 is STILL in flight

      resolveDelta(); // tick 1 finally resolves -> its OWN .finally() re-arms too (chain C)
      await jest.advanceTimersByTimeAsync(0);

      // Advance exactly one interval past the point where BOTH chain B and
      // chain C would fire if left un-collapsed. The fix guarantees only the
      // LAST-armed chain (C) survives — chain B was cleared out from under it.
      await jest.advanceTimersByTimeAsync(20000);

      // tick 1 (from chain A) + exactly ONE follow-up tick (from whichever
      // chain survived) = 2. A live chain B running ALONGSIDE chain C would
      // make this 3.
      expect(delta.execute).toHaveBeenCalledTimes(2);
    });
  });

  // ── fix-wave-2 R4 — health tracked PER LANE. Before this fix, ANY tick's
  // success (delta OR backfill) reset a single SHARED `consecutiveFailures`
  // counter to 0 — a healthy backfill tick made a chronically-broken delta
  // lane look "recovered" every other tick, so `degraded`/`consecutiveFailures`
  // oscillated 0↔1 forever during exactly the sustained-degradation scenario
  // F4's circuit breaker exists to handle, instead of escalating (which is
  // how the ORIGINAL F4 bug was even detected, via a probe reaching 50).
  describe('R4: per-lane health — one lane succeeding must not erase the other lane\'s failure signal', () => {
    it('a persistently failing delta keeps the status degraded even on ticks where backfill succeeds', async () => {
      const { state, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      // Composite (pending-pages) cursor ⇒ delta is ALWAYS "due", regardless of lastRunAt.
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:0', lastRunAt: new Date(), lastResult: 'error: GR down', itemsSynced: 0 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;
      (scheduler as unknown as { syncBackfill: { execute: jest.Mock } }).syncBackfill = fakeBackfill({ pageProcessed: 5, monthAdvanced: false, done: false }) as never;

      let sawBackfillSucceedWhileNotDegraded = false;
      for (let i = 0; i < 12; i++) {
        const r = await scheduler.tick();
        if (r.lane === 'backfill' && !scheduler.status.degraded) sawBackfillSucceedWhileNotDegraded = true;
      }

      // The R4 bug, made concrete: a successful backfill tick must NEVER be
      // the reason `degraded` reads false while the delta lane is still
      // chronically broken.
      expect(sawBackfillSucceedWhileNotDegraded).toBe(false);
      expect(scheduler.status.degraded).toBe(true);
      expect(scheduler.status.consecutiveFailures).toBeGreaterThan(0);
    });

    it('activeLane returns to "idle" after a failed tick, never keeping the LAST successful lane displayed as healthy', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta({ pageProcessed: 1, hasPendingPages: false, coveredThroughDate: '15-07-2026' }) as never;

      await scheduler.tick();
      expect(scheduler.status.activeLane).toBe('delta');

      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;
      await scheduler.tick();

      expect(scheduler.status.activeLane).toBe('idle');
    });
  });

  // ── fix-wave-2 R5 — applies F5's principle to the SCHEDULER's own config
  // read. Before this fix, `await this.syncConfig.get()` had no try/catch at
  // all: a rejection escaped `tick()` uncaught, and `scheduleNext`'s
  // `void this.tick().finally(...)` (no `.catch`) let it fall into
  // `main.ts`'s process-wide `unhandledRejection` handler — no backoff, no
  // `consecutiveFailures`, no `lastResult`, status stayed green while the
  // scheduler silently did nothing every tick.
  describe('R5: a config-repo failure is caught, tracked, and falls back to safe defaults', () => {
    // fix-wave-3 R7 — this test PINS TWO SEPARATE claims that fix-wave-2
    // conflated into one assertion ("a lane actually ran, using the fallback
    // defaults"): (1) the PACING knobs are safe to fall back to defaults
    // (unchanged), and (2) `enabled` reads `true` here ONLY because no tick
    // EVER observed a real `enabled=false` yet (the pre-first-tick optimistic
    // default, same as R3) — NOT because a failed read is entitled to invent
    // "enabled". See the "R7" describe block below for the scenario where a
    // REAL `enabled=false` was already observed — that is the case fix-wave-2
    // left open, and this test alone could not tell the difference.
    it('a config repo that throws does NOT reject tick() — falls back to default PACING and still runs a lane (enabled stays at its last-observed/optimistic value)', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const throwingConfig = { get: jest.fn(async () => { throw new Error('config DB down'); }) };
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, throwingConfig as never, fakeReconcile() as never, { silent: true });

      const result = await scheduler.tick();

      expect(result.error).toBeUndefined(); // did NOT abort the tick
      expect(result.lane).toBeDefined(); // a lane actually ran, using the fallback defaults
      expect(scheduler.status.requestIntervalMs).toBe(FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs);
      expect(scheduler.status.enabled).toBe(true); // optimistic default — no tick ever observed a REAL enabled=false
    });

    it('the config-read failure IS tracked — the status reports degraded even though the lane itself succeeded', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const throwingConfig = { get: jest.fn(async () => { throw new Error('config DB down'); }) };
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, throwingConfig as never, fakeReconcile() as never, { silent: true });

      await scheduler.tick();

      expect(scheduler.status.degraded).toBe(true);
      expect(scheduler.status.consecutiveFailures).toBeGreaterThan(0);
    });

    it('a config repo that recovers resets the config-failure streak', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      let shouldThrow = true;
      const flakyConfig = {
        get: jest.fn(async () => {
          if (shouldThrow) throw new Error('config DB down');
          return syncConfig.get();
        }),
      };
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, flakyConfig as never, fakeReconcile() as never, { silent: true });

      await scheduler.tick();
      expect(scheduler.status.degraded).toBe(true);

      shouldThrow = false;
      await scheduler.tick();

      expect(scheduler.status.degraded).toBe(false);
      expect(scheduler.status.consecutiveFailures).toBe(0);
    });

    it('repeated config failures do NOT crash the process — tick() always resolves, never rejects', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const throwingConfig = { get: jest.fn(async () => { throw new Error('config DB down'); }) };
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, throwingConfig as never, fakeReconcile() as never, { silent: true });

      for (let i = 0; i < 5; i++) {
        await expect(scheduler.tick()).resolves.toBeDefined();
      }
    });
  });

  // ── fix-wave-3 R7 — R5 opened a bypass of the kill-switch: with a REAL
  // `enabled=false` already observed by a tick, a SUBSEQUENT config-read
  // failure must NEVER resume GR calls. Before the fix, `readConfigSafely`
  // returned `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` wholesale on failure —
  // `.enabled` on that constant is `true` — so `cfg.enabled` (and therefore
  // `this.currentEnabled`) flipped back to `true` on the very next failed
  // read, resuming ticks against the operator's explicit decision and making
  // `/sync/status`/`isEnabled()` lie in exactly the field R3 added so they
  // wouldn't.
  describe('R7: enabled=false survives a config-read failure — the kill-switch never re-enables itself', () => {
    it('enabled=false observed by a tick, THEN the config repo starts throwing — the tick still skips and status.enabled stays false', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ enabled: false });
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      // First tick: a REAL read observes enabled=false.
      const first = await scheduler.tick();
      expect(first.skipped).toBe(true);
      expect(scheduler.status.enabled).toBe(false);
      expect(delta.execute).not.toHaveBeenCalled();

      // Now the config repo starts failing (a query timeout, a locked row —
      // it does NOT need to be fully down). The operator never touched
      // `enabled` again; it must still read false.
      jest.spyOn(syncConfig, 'get').mockImplementation(async () => {
        throw new Error('config DB timeout');
      });

      const second = await scheduler.tick();

      expect(second.skipped).toBe(true); // the tick must NOT resume GR calls
      expect(delta.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
      expect(scheduler.status.enabled).toBe(false); // never lies back to true
    });

    it('isEnabled() (the /sync/run 503 guard) also stays false across the same failure', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ enabled: false });
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      await scheduler.tick();
      expect(scheduler.isEnabled()).toBe(false);

      jest.spyOn(syncConfig, 'get').mockImplementation(async () => {
        throw new Error('config DB timeout');
      });
      await scheduler.tick();

      expect(scheduler.isEnabled()).toBe(false);
    });

    it('pacing (requestIntervalMs) STILL falls back to defaults on the same failure — only `enabled` is asymmetric', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ enabled: false, requestIntervalMs: 5000 });
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      await scheduler.tick();
      expect(scheduler.status.requestIntervalMs).toBe(5000);

      jest.spyOn(syncConfig, 'get').mockImplementation(async () => {
        throw new Error('config DB timeout');
      });
      await scheduler.tick();

      // Pacing knobs are NOT load-bearing for the kill-switch decision — they
      // fall back to the shared defaults, same as before this fix.
      expect(scheduler.status.requestIntervalMs).toBe(FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs);
      expect(scheduler.status.enabled).toBe(false); // but enabled did NOT fall back
    });

    // fix-wave-4 W3 — this test USED TO pin the fail-OPEN outcome below as
    // correct ("keeps the optimistic true default") for a scheduler whose
    // FIRST-EVER config read fails. That is true ONLY for a scheduler built
    // and ticked directly, bypassing `start()` — a shape no production code
    // path takes (`main.ts` always calls `start()`). Rewritten to also pin
    // the OPPOSITE, and actually load-bearing, guarantee for the REAL boot
    // path — see the dedicated "W3: start() boot fail-closed" describe block
    // below for the reproduction of the bug this pinning used to hide.
    it('tick() called directly (bypassing start()) keeps the pre-boot optimistic true default when the FIRST-EVER read fails — start() is what forces fail-closed, not tick() alone', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const throwingConfig = { get: jest.fn(async () => { throw new Error('config DB down'); }) };
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, throwingConfig as never, fakeReconcile() as never, { silent: true });

      // No `start()` call — this is the shape unit tests use throughout this
      // file, never the real boot path. Documented, not "fixed": nothing in
      // production ticks a scheduler that was never started.
      await scheduler.tick();

      expect(scheduler.status.enabled).toBe(true);
    });
  });

  // ── fix-wave-4 W3 — R7 closed the "kill-switch re-enables itself on a later
  // read failure" gap, but ONLY for a value already observed by a PRIOR
  // successful tick. `currentEnabled`'s optimistic `true` default has no such
  // prior observation to fall back on right after a process restart: R7's own
  // rule ("a failed read can only ever repeat what was already known") still
  // let the FIRST-EVER read failure resume GR calls, because "what was
  // already known" at boot was the optimistic default, not a real DB value.
  // Probed scenario: operator sets `enabled=false` (kill-switch) → deploy
  // (=restart, no staging) → the config repo happens to be unreachable
  // (pool exhausted, a timeout) exactly when the FIRST tick after `start()`
  // reads it. Before this fix, that combination resumed GR calls for as long
  // as the read stayed broken — not a 20s window, however long the outage lasted.
  describe('W3: start() boot fail-closed — a config read that never succeeds before the first tick must not resume GR calls', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('enabled=false in the DB + the config repo throwing from the very first read after start() ⇒ zero GR calls, status.enabled stays false', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      // The REAL DB value the operator set — but every read of it fails,
      // exactly the "pool saturado justo en el arranque" scenario.
      const throwingConfig = {
        get: jest.fn(async () => {
          throw new Error('config DB timeout');
        }),
      };
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, throwingConfig as never, fakeReconcile() as never, { silent: true });

      scheduler.start();
      // Before the fix: `currentEnabled` stayed at the optimistic `true` set
      // at construction, so this first tick's failed read fell back to
      // `enabled: true` and called GR. After the fix: `start()` forces
      // `false` first, so the same failed read falls back to `false`.
      await jest.advanceTimersByTimeAsync(FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs);

      expect(delta.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
      expect(scheduler.status.enabled).toBe(false);
      expect(scheduler.isEnabled()).toBe(false); // the /sync/run 503 guard

      // The outage is NOT a 20s window — it lasts as long as the read stays
      // broken. A second tick under the same failure must still stay closed.
      await jest.advanceTimersByTimeAsync(FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs);
      expect(delta.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
      expect(scheduler.status.enabled).toBe(false);
    });

    it('a HEALTHY first read after start() is unaffected — no artificial delay on a normal boot', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ requestIntervalMs: 20000, deltaCheckIntervalMs: 300000 }); // enabled stays true (default)
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      scheduler.start();
      await jest.advanceTimersByTimeAsync(20000);

      // The FIRST tick's own successful read overwrites the fail-closed
      // default immediately — a healthy boot is NOT held back at all.
      expect(delta.execute).toHaveBeenCalledTimes(1);
      expect(scheduler.status.enabled).toBe(true);
    });

    it('start() with a REAL enabled=false in the DB and a working config repo skips from the very first tick (baseline, unaffected by this fix)', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
      await syncConfig.update({ requestIntervalMs: 20000, enabled: false });
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const scheduler = new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, syncConfig, fakeReconcile() as never, { silent: true });

      scheduler.start();
      await jest.advanceTimersByTimeAsync(20000);

      expect(delta.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
      expect(scheduler.status.enabled).toBe(false);
    });
  });

  // ── fix-wave-3 R8 — R4 accidentally coupled the SHARED request-pacing
  // backoff to the WORST per-lane failure streak, persistence included. A
  // poisoned recibo that only breaks PERSISTENCE (GR itself healthy) must
  // never slow down the request rhythm — that punishes the HEALTHY lane
  // (backfill) for a failure it has nothing to do with. `finance-receipts-
  // ingest-seam.test.ts` exercises this with the REAL use cases; this test
  // isolates the scheduler's OWN arbitration logic with fakes, and — unlike
  // the pre-existing F4 tests — actually LOOKS at `effectiveIntervalMs`
  // (the F4 tests only ever checked that the backfill "progressed").
  describe('R8: the shared pacing backoff responds to GR health, never to a lane\'s PERSISTENCE failures', () => {
    it('4 consecutive delta PERSISTENCE failures (GR healthy) never move effectiveIntervalMs off the base pace', async () => {
      const { scheduler, syncConfig } = makeHarness();
      // fix-wave-1 F4's starvation alternation is a SEPARATE concern (covered
      // by its own describe block above) — a high threshold here keeps this
      // test isolated to ONLY the pacing signal R8 fixes, not which lane gets
      // the turn.
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaStarvationThreshold: 100 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = {
        execute: jest.fn(async () => { throw new FinanceReceiptPersistenceError(new Error('P2000: poisoned row')); }),
      } as never;

      for (let i = 0; i < 4; i++) {
        const r = await scheduler.tick();
        expect(r.error).toBeDefined();
        // This is the exact assertion the pre-existing F4 tests never made —
        // before fix-wave-3 this would be 40000, 80000, 160000, 300000 (capped).
        expect(scheduler.status.effectiveIntervalMs).toBe(20000);
      }
    });

    it('the SAME 4 failures still count toward /sync/status degraded + the F4 circuit breaker (per-lane health is unchanged)', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaCheckIntervalMs: 300000 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = {
        execute: jest.fn(async () => { throw new FinanceReceiptPersistenceError(new Error('P2000: poisoned row')); }),
      } as never;

      for (let i = 0; i < 4; i++) await scheduler.tick();

      expect(scheduler.status.degraded).toBe(true);
      expect(scheduler.status.consecutiveFailures).toBeGreaterThan(0);
    });

    it('a GR-fetch failure (NOT wrapped as FinanceReceiptPersistenceError) DOES escalate effectiveIntervalMs, same as before', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;

      await scheduler.tick();
      expect(scheduler.status.effectiveIntervalMs).toBe(40000);
      await scheduler.tick();
      expect(scheduler.status.effectiveIntervalMs).toBe(80000);
    });

    it('a persistence failure resets an ALREADY-escalated GR backoff (the fetch inside that execute() call still had to succeed)', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000 });
      const mockDelta = { execute: jest.fn() };
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = mockDelta as never;

      mockDelta.execute.mockRejectedValueOnce(new Error('GR down'));
      await scheduler.tick();
      expect(scheduler.status.effectiveIntervalMs).toBe(40000);

      mockDelta.execute.mockRejectedValueOnce(new FinanceReceiptPersistenceError(new Error('poisoned row')));
      await scheduler.tick();

      expect(scheduler.status.effectiveIntervalMs).toBe(20000); // GR answered fine this tick — backoff clears
    });

    // ── gr-receipt-annulment (design.md Decision 4, task 3.3) — the systemic
    // guard's abort must NOT be read as "GR is unwell" either, same
    // criterion as a persistence failure. Exercised here on the delta lane
    // (the guard's own carrier, `SyncGrReceiptsReconcileWindow`, doesn't
    // exist yet at this point in the build — but `trackGrHealth` is generic
    // over ANY lane's thrown error, so this pins the classifier itself).
    it('a FinanceReceiptAnnulmentGuardError (the systemic guard aborting) never escalates effectiveIntervalMs — GR is not culpable', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaStarvationThreshold: 100 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = {
        execute: jest.fn(async () => { throw new FinanceReceiptAnnulmentGuardError('ABORT anulados=63/100'); }),
      } as never;

      for (let i = 0; i < 4; i++) {
        const r = await scheduler.tick();
        expect(r.error).toBeDefined();
        expect(scheduler.status.effectiveIntervalMs).toBe(20000);
      }
    });

    it('a FinanceReceiptAnnulmentGuardError still counts toward per-lane health (/sync/status degraded)', async () => {
      const { scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaCheckIntervalMs: 300000 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = {
        execute: jest.fn(async () => { throw new FinanceReceiptAnnulmentGuardError('ABORT anulados=63/100'); }),
      } as never;

      await scheduler.tick();

      expect(scheduler.status.degraded).toBe(true);
      expect(scheduler.status.consecutiveFailures).toBeGreaterThan(0);
    });
  });

  // ── fix-wave-4 W1 — R8 (above) reset `grConsecutiveFailures` on ANY
  // backfill "success", including the no-op it returns once fully `done`
  // (`SyncGrReceiptsBackfillBatch.execute()`'s early return — ZERO calls to
  // `gr.fetchReceipts`). Probed scenario (~4 days post-deploy, backfill
  // steady-state `done`, GR itself down): every F4-alternation turn backfill
  // gets falsely "proved GR healthy" via a call that never touched GR,
  // oscillating the shared backoff 20s<->40s FOREVER instead of escalating to
  // `maxRequestIntervalMs` — ~10x more requests against a downed GR. NONE of
  // the pre-existing R8 tests combine a `done` (no-op) backfill with a delta
  // failing on the FETCH (they isolate the pacing signal with
  // `deltaStarvationThreshold: 100` so backfill never gets a turn at all) —
  // this is the first test that lets both lanes actually interleave AND
  // watches `effectiveIntervalMs` through it.
  describe('W1: a backfill no-op success ("done", zero GR calls) must not reset the shared pacing backoff', () => {
    it('delta genuinely down (GR fetch failure) + backfill already `done` (no-op every turn) ⇒ the backoff escalates to the cap and STAYS there, never oscillating back to base pace', async () => {
      const { state, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaCheckIntervalMs: 300000 });
      // Composite (pending-pages) cursor ⇒ delta is ALWAYS "due", regardless
      // of lastRunAt — same F4 fixture idiom used throughout this file.
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:0', lastRunAt: new Date(), lastResult: 'error: GR down', itemsSynced: 0 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;
      // backfill stays the harness DEFAULT — already `{ pageProcessed: 0,
      // monthAdvanced: false, done: true }`, the exact no-op shape
      // `SyncGrReceiptsBackfillBatch.execute()` returns once fully disarmed.

      const intervals: number[] = [];
      for (let i = 0; i < 8; i++) {
        await scheduler.tick();
        intervals.push(scheduler.status.effectiveIntervalMs);
      }

      // Before the fix: every backfill no-op turn (the F4-alternation "even"
      // ticks) reset grConsecutiveFailures to 0, so the sequence oscillated
      // 40000/80000/160000 (delta ticks) <-> 20000 (backfill no-op ticks)
      // forever — `intervals` would contain 20000 well past the first tick.
      expect(intervals).not.toContain(20000);
      // After the fix: the backoff escalates monotonically and clamps at the cap.
      expect(intervals[intervals.length - 1]).toBe(300000);
    });

    it('a backfill turn that ACTUALLY calls GR (not yet `done`) still resets the pacing backoff normally, unaffected by this fix', async () => {
      const { state, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaCheckIntervalMs: 300000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:0', lastRunAt: new Date(), lastResult: 'error: GR down', itemsSynced: 0 });
      (scheduler as unknown as { syncDelta: { execute: jest.Mock } }).syncDelta = fakeDelta(new Error('GR down')) as never;
      // Backfill genuinely progressing (NOT done) — a real GR call happened.
      (scheduler as unknown as { syncBackfill: { execute: jest.Mock } }).syncBackfill = fakeBackfill({ pageProcessed: 5, monthAdvanced: false, done: false }) as never;

      let sawResetOnBackfillTurn = false;
      for (let i = 0; i < 6; i++) {
        const r = await scheduler.tick();
        if (r.lane === 'backfill' && scheduler.status.effectiveIntervalMs === 20000) sawResetOnBackfillTurn = true;
      }

      expect(sawResetOnBackfillTurn).toBe(true);
    });
  });

  // ── gr-receipt-annulment (design.md Decision 1) — the third lane's
  // arbitration: delta > reconcile > backfill, strict priority. Reconcile
  // mirrors delta's F4 anti-starvation mechanic (SAME knob,
  // `deltaStarvationThreshold` — no new one invented) but with its OWN
  // counter (`reconcileConsecutiveFailures`, never shared with delta's) —
  // R4's lesson applied to the new lane: a shared counter lets one lane's
  // recovery mask another's sustained failure.
  describe('gr-receipt-annulment: reconcile lane arbitration (delta > reconcile > backfill)', () => {
    it('scenario 6 — delta claims the tick over reconcile and backfill, even when both have work', async () => {
      const { state, delta, backfill, reconcile, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026:15-07-2026:20', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 20 });
      // reconcile is due by default (never ran) — same "also has work" shape as backfill.

      const result = await scheduler.tick();

      expect(delta.execute).toHaveBeenCalledTimes(1);
      expect(reconcile.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
      expect(result.lane).toBe('delta');
    });

    it('scenario 7 — reconcile claims the tick when delta is quiet and its own cadence is due, ahead of backfill', async () => {
      const now = new Date('2026-08-10T12:05:00Z');
      const { state, delta, backfill, reconcile, scheduler, syncConfig } = makeHarness({ now: () => now });
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      // Delta NOT due: plain cursor, interval not elapsed.
      await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date('2026-08-10T12:02:00Z'), lastResult: 'ok', itemsSynced: 1 });
      // Reconcile's cadence elapsed (default 6h, last ran 12h ago) — overrides `makeHarness`'s "just satisfied" default.
      await state.save({ entity: RECONCILE_ENTITY, cursor: null, lastRunAt: new Date('2026-08-10T00:00:00Z'), lastResult: 'sweep ok', itemsSynced: 5 });

      const result = await scheduler.tick();

      expect(reconcile.execute).toHaveBeenCalledTimes(1);
      expect(delta.execute).not.toHaveBeenCalled();
      expect(backfill.execute).not.toHaveBeenCalled();
      expect(result.lane).toBe('reconcile');
    });

    it('scenario 8 — backfill is not starved indefinitely: it gets the turn once reconcile has no pending work and its cadence has not elapsed', async () => {
      const now = new Date('2026-08-10T12:05:00Z');
      const { state, delta, backfill, reconcile, scheduler, syncConfig } = makeHarness({ now: () => now });
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000, reconcileCheckIntervalMs: 21600000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date('2026-08-10T12:02:00Z'), lastResult: 'ok', itemsSynced: 1 });
      // Reconcile's sweep already closed AND its cadence has not elapsed.
      await state.save({ entity: RECONCILE_ENTITY, cursor: null, lastRunAt: new Date('2026-08-10T10:00:00Z'), lastResult: 'sweep ok', itemsSynced: 5 });

      const result = await scheduler.tick();

      expect(backfill.execute).toHaveBeenCalledTimes(1);
      expect(delta.execute).not.toHaveBeenCalled();
      expect(reconcile.execute).not.toHaveBeenCalled();
      expect(result.lane).toBe('backfill');
    });

    it('reconcile is due when its own sweep still has pending pages (composite cursor), regardless of cadence', async () => {
      const now = new Date('2026-08-10T12:05:00Z');
      const { state, backfill, reconcile, scheduler, syncConfig } = makeHarness({ now: () => now });
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date('2026-08-10T12:02:00Z'), lastResult: 'ok', itemsSynced: 1 });
      await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:100', lastRunAt: new Date('2026-08-10T12:04:00Z'), lastResult: 'page ok @100', itemsSynced: 100 });

      const result = await scheduler.tick();

      expect(reconcile.execute).toHaveBeenCalledTimes(1);
      expect(backfill.execute).not.toHaveBeenCalled();
      expect(result.lane).toBe('reconcile');
    });

    it('reconcileEnabled: false means reconcile is never due — backfill gets the turn instead (delta already satisfied)', async () => {
      const { state, backfill, reconcile, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      await syncConfig.update({ reconcileEnabled: false });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 }); // delta NOT due

      const result = await scheduler.tick();

      expect(backfill.execute).toHaveBeenCalledTimes(1);
      expect(reconcile.execute).not.toHaveBeenCalled();
      expect(result.lane).toBe('backfill');
    });

    it('activeLane reports "reconcile" while it holds the turn', async () => {
      const { state, scheduler, syncConfig } = makeHarness();
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 }); // delta NOT due
      await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:0', lastRunAt: new Date(), lastResult: 'error: x', itemsSynced: 0 }); // reconcile due (pending pages)

      const result = await scheduler.tick();

      expect(result.lane).toBe('reconcile');
      expect(scheduler.status.activeLane).toBe('reconcile');
    });

    describe('F4 mirrored for reconcile — own counter, same knob', () => {
      it('after deltaStarvationThreshold consecutive reconcile failures, backfill starts getting turns even though reconcile remains "due"', async () => {
        const { state, backfill, reconcile, scheduler, syncConfig } = makeHarness();
        await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
        await state.save({ entity: DELTA_ENTITY, cursor: '10-07-2026', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
        // Reconcile has a composite (pending-pages) cursor -> ALWAYS "due".
        await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:0', lastRunAt: new Date(), lastResult: 'error: GR down', itemsSynced: 0 });
        (scheduler as unknown as { syncReconcile: { execute: jest.Mock } }).syncReconcile = fakeReconcile(new Error('GR down')) as never;

        await scheduler.tick();
        await scheduler.tick();
        await scheduler.tick();
        expect(backfill.execute).not.toHaveBeenCalled();

        let backfillRanAtLeastOnce = false;
        for (let i = 0; i < 10; i++) {
          const r = await scheduler.tick();
          if (r.lane === 'backfill') backfillRanAtLeastOnce = true;
        }

        expect(backfillRanAtLeastOnce).toBe(true);
        void reconcile;
      });

      it("reconcile's failure streak does NOT feed delta's own F4 counter, and vice versa — independent circuit breakers", async () => {
        // Fixed clock — same "reloj vivo" hazard already fixed elsewhere in
        // this file (pinning `lastRunAt` to a literal timestamp while `now`
        // stays on the REAL wall clock made this flaky under the full suite,
        // where wall-clock drift/contention can push `now - lastRunAt` past
        // `deltaCheckIntervalMs`, making delta unexpectedly "due").
        const now = new Date('2026-08-10T14:00:00Z');
        const { state, delta, scheduler, syncConfig } = makeHarness({ now: () => now });
        await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
        // Delta is NOT due (plain cursor, interval fresh) so every tick goes to reconcile.
        await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date('2026-08-10T13:59:00Z'), lastResult: 'ok', itemsSynced: 1 });
        await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:0', lastRunAt: now, lastResult: 'error: GR down', itemsSynced: 0 });
        (scheduler as unknown as { syncReconcile: { execute: jest.Mock } }).syncReconcile = fakeReconcile(new Error('GR down')) as never;

        for (let i = 0; i < 5; i++) await scheduler.tick();

        // Delta never even attempted — its own F4 streak must stay at 0, so a
        // FUTURE delta failure still gets the full deltaStarvationThreshold
        // grace period, unpolluted by reconcile's unrelated failures.
        expect(delta.execute).not.toHaveBeenCalled();
      });
    });

    it('worstConsecutiveFailures (degraded/consecutiveFailures on /sync/status) includes the reconcile counter', async () => {
      // Fixed clock — pinning `lastRunAt` to a literal timestamp while
      // leaving `now` on the REAL wall clock is exactly the "reloj vivo"
      // brittleness this repo has been bitten by before (the isDeltaDue
      // check would silently flip from NOT-due to due depending on when the
      // suite happens to run).
      const now = new Date('2026-08-10T14:00:00Z');
      const { state, scheduler, syncConfig } = makeHarness({ now: () => now });
      await seedConfig(syncConfig, { deltaCheckIntervalMs: 300000 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date('2026-08-10T13:59:00Z'), lastResult: 'ok', itemsSynced: 1 });
      await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:0', lastRunAt: now, lastResult: 'error: GR down', itemsSynced: 0 });
      (scheduler as unknown as { syncReconcile: { execute: jest.Mock } }).syncReconcile = fakeReconcile(new Error('GR down')) as never;

      await scheduler.tick();

      expect(scheduler.status.degraded).toBe(true);
      expect(scheduler.status.consecutiveFailures).toBeGreaterThan(0);
    });

    it('a reconcile failure that is a FinanceReceiptPersistenceError does not escalate the shared pacing backoff (same R8 criterion as delta/backfill)', async () => {
      const now = new Date('2026-08-10T14:00:00Z');
      const { state, scheduler, syncConfig } = makeHarness({ now: () => now });
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaCheckIntervalMs: 300000, deltaStarvationThreshold: 100 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date('2026-08-10T13:59:00Z'), lastResult: 'ok', itemsSynced: 1 });
      // Reconcile due (pending pages) every tick — the poisoned fake below never advances the cursor either.
      await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:0', lastRunAt: now, lastResult: 'ok', itemsSynced: 0 });
      (scheduler as unknown as { syncReconcile: { execute: jest.Mock } }).syncReconcile = {
        execute: jest.fn(async () => { throw new FinanceReceiptPersistenceError(new Error('P2000: poisoned row')); }),
      } as never;

      for (let i = 0; i < 4; i++) {
        const r = await scheduler.tick();
        expect(r.error).toBeDefined(); // confirms reconcile was actually ATTEMPTED (and failed), not skipped/no-op
        expect(scheduler.status.effectiveIntervalMs).toBe(20000);
      }
    });

    it('a reconcile failure that is a FinanceReceiptAnnulmentGuardError also does not escalate the shared pacing backoff', async () => {
      const now = new Date('2026-08-10T14:00:00Z');
      const { state, scheduler, syncConfig } = makeHarness({ now: () => now });
      await seedConfig(syncConfig, { requestIntervalMs: 20000, maxRequestIntervalMs: 300000, deltaCheckIntervalMs: 300000, deltaStarvationThreshold: 100 });
      await state.save({ entity: DELTA_ENTITY, cursor: '10-08-2026', lastRunAt: new Date('2026-08-10T13:59:00Z'), lastResult: 'ok', itemsSynced: 1 });
      await state.save({ entity: RECONCILE_ENTITY, cursor: '07-07-2026:10-08-2026:0', lastRunAt: now, lastResult: 'ok', itemsSynced: 0 });
      (scheduler as unknown as { syncReconcile: { execute: jest.Mock } }).syncReconcile = {
        execute: jest.fn(async () => { throw new FinanceReceiptAnnulmentGuardError('ABORT anulados=63/100'); }),
      } as never;

      for (let i = 0; i < 4; i++) {
        const r = await scheduler.tick();
        expect(r.error).toBeDefined();
        expect(scheduler.status.effectiveIntervalMs).toBe(20000);
      }
    });
  });

  // ── gr-receipt-annulment (design.md Wiring, "el pin del composition root")
  // — THREE layers, in order of strength. This describe block pins the first
  // two (type + runtime); the third (text-slice pin of the REAL
  // bootstrap wiring) lives in `finance-growth-composition-root.test.ts`.
  describe('gr-receipt-annulment: syncReconcile wiring pins (design.md Wiring)', () => {
    // Layer 1 (strongest): the TYPE SYSTEM. A bootstrap that drops
    // `syncReconcile` must fail to COMPILE. If someone loosens the
    // constructor's 6th parameter back to optional, this `@ts-expect-error`
    // becomes UNUSED — and an unused `@ts-expect-error` is itself a
    // TypeScript compile error, so this whole test FILE fails to build,
    // catching the regression before any test even runs.
    it('aridity pin — constructing WITHOUT syncReconcile is a TYPE ERROR', () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const cfg = new InMemoryFinanceReceiptSyncConfigRepository();
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      expect(() => {
        // @ts-expect-error — syncReconcile es OBLIGATORIO (design.md Wiring): si esto
        // deja de dar error de tipos, alguien lo volvió opcional y un wiring
        // perdido pasa a ser silencioso (F13/R9, el mismo patrón que itemRepo/retencionRepo).
        return new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, cfg);
      }).toThrow();
    });

    // Layer 2: RUNTIME. Catches the JS-without-types case the type layer can't.
    it('runtime pin — the constructor THROWS when syncReconcile is falsy, even bypassing the type system', () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const cfg = new InMemoryFinanceReceiptSyncConfigRepository();
      const delta = fakeDelta();
      const backfill = fakeBackfill();

      expect(() => new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, cfg, undefined as never)).toThrow(
        /syncReconcile is REQUIRED/,
      );
      expect(() => new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, cfg, null as never)).toThrow(
        /syncReconcile is REQUIRED/,
      );
    });

    it('does NOT throw when syncReconcile is provided', () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      const cfg = new InMemoryFinanceReceiptSyncConfigRepository();
      const delta = fakeDelta();
      const backfill = fakeBackfill();
      const reconcile = fakeReconcile();

      expect(() => new FinanceReceiptIngestScheduler(delta as never, backfill as never, state, lock, cfg, reconcile as never)).not.toThrow();
    });
  });
});
