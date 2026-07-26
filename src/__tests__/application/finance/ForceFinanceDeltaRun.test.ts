import { ForceFinanceDeltaRun } from '@application/use-cases/finance/ForceFinanceDeltaRun';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';

const DELTA_ENTITY = 'finance-receipts-delta';

describe('ForceFinanceDeltaRun', () => {
  it('with no prior row, resolves {started:true} and creates nothing (a first tick is already "due")', async () => {
    const state = new InMemorySyncStateRepository();
    const lock = new InMemoryDistributedLock();
    const uc = new ForceFinanceDeltaRun(state, lock, { retryDelayMs: 0 });

    const result = await uc.execute();

    expect(result).toEqual({ started: true });
    expect(await state.get(DELTA_ENTITY)).toBeNull();
  });

  it('with a prior row, clears ONLY lastRunAt — cursor/lastResult/itemsSynced are untouched', async () => {
    const state = new InMemorySyncStateRepository();
    const lock = new InMemoryDistributedLock();
    await state.save({ entity: DELTA_ENTITY, cursor: '14-07-2026', lastRunAt: new Date('2026-07-15T10:00:00Z'), lastResult: 'ok', itemsSynced: 9 });
    const uc = new ForceFinanceDeltaRun(state, lock, { retryDelayMs: 0 });

    await uc.execute();

    const saved = await state.get(DELTA_ENTITY);
    expect(saved?.lastRunAt).toBeNull();
    expect(saved?.cursor).toBe('14-07-2026');
    expect(saved?.lastResult).toBe('ok');
    expect(saved?.itemsSynced).toBe(9);
  });

  it('releases the lock after a successful write', async () => {
    const state = new InMemorySyncStateRepository();
    const lock = new InMemoryDistributedLock();
    const uc = new ForceFinanceDeltaRun(state, lock, { retryDelayMs: 0 });

    await uc.execute();

    expect(lock.heldKeys.has('finance-receipts-ingest')).toBe(false);
  });

  // ── fix-wave-3 R10 — supersedes fix-wave-2 R2's "never write unlocked"
  // stance for THIS use case. R2's OWN docblock already proves the lock is
  // NOT load-bearing here (the targeted `clearLastRunAt` write is safe in
  // EITHER order against a concurrent tick) — so refusing to write when the
  // lock is merely busy traded a real, always-safe write for a 500 the
  // re-review measured on ~10-15% of requests (the budget was sized to GR's
  // fetch latency, not the tick's TOTAL hold of 4 transactions + N upserts).
  it('proceeds WITHOUT the lock (best-effort) when the lock stays unavailable for the whole retry budget — the write is safe regardless', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: DELTA_ENTITY, cursor: '14-07-2026', lastRunAt: new Date('2026-07-15T10:00:00Z'), lastResult: 'ok', itemsSynced: 9 });
    const lock = new InMemoryDistributedLock();
    lock.forceAcquireFails = true;
    const uc = new ForceFinanceDeltaRun(state, lock, { maxLockAttempts: 3, retryDelayMs: 0 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await uc.execute();

    expect(result).toEqual({ started: true });
    const saved = await state.get(DELTA_ENTITY);
    expect(saved?.lastRunAt).toBeNull(); // the write DID happen, unlocked
    expect(saved?.cursor).toBe('14-07-2026'); // untouched — targeted update
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/lock .* busy/i));
    warnSpy.mockRestore();
  });

  it('never calls lock.release() when the lock was never acquired', async () => {
    const state = new InMemorySyncStateRepository();
    const lock = new InMemoryDistributedLock();
    lock.forceAcquireFails = true;
    const releaseSpy = jest.spyOn(lock, 'release');
    const uc = new ForceFinanceDeltaRun(state, lock, { maxLockAttempts: 2, retryDelayMs: 0 });

    await uc.execute();

    expect(releaseSpy).not.toHaveBeenCalled();
  });

  // ── fix-wave-2 R2 — the concurrency probe. A "tick" holds the lock for the
  // ENTIRE measured hold duration (~1.2s in prod; here compressed but still a
  // real `await` gap so a naive read-modify-write in `ForceFinanceDeltaRun`
  // would race it) while doing its OWN full-row read-modify-write (advancing
  // cursor/itemsSynced, exactly like `SyncGrReceiptsDelta.execute()` does).
  // `force.execute()` runs CONCURRENTLY. Before the fix (fix-wave-1's 80ms
  // budget + full-row read-modify-write), this reproduced BOTH failure modes:
  // (A) force's stale copy rewinds the tick's fresher cursor, or (B) the
  // tick's own save overwrites force's `lastRunAt: null`. The fix (targeted
  // `clearLastRunAt` + a lock budget sized to the real hold) must close BOTH.
  describe('concurrency: a tick in flight must not lose the force, and the force must not rewind the cursor', () => {
    async function simulateInFlightTick(
      state: InMemorySyncStateRepository,
      lock: InMemoryDistributedLock,
      holdMs: number,
    ): Promise<void> {
      const acquired = await lock.tryAcquire('finance-receipts-ingest');
      expect(acquired).toBe(true); // the tick starts FIRST, uncontested
      try {
        const prior = await state.get(DELTA_ENTITY);
        // Simulate the GR fetch + persistence latency (measured 1019-1251ms in prod).
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        // The tick's own full-row read-modify-write — advances the cursor and
        // itemsSynced, exactly like SyncGrReceiptsDelta.execute() does at the
        // end of a successful page.
        await state.save({
          entity: DELTA_ENTITY,
          cursor: '15-07-2026', // advanced past the prior '14-07-2026'
          lastRunAt: new Date('2026-07-15T12:00:00Z'),
          lastResult: 'ok',
          itemsSynced: (prior?.itemsSynced ?? 0) + 1, // 9 -> 10
        });
      } finally {
        await lock.release('finance-receipts-ingest');
      }
    }

    // `holdMs` deliberately exceeds fix-wave-1's DEFAULT retry budget (5 ×
    // 20ms = 80ms) while staying comfortably under fix-wave-2's DEFAULT
    // budget (16 × 100ms = 1500ms) — using DEFAULT options on `force` (no
    // override) is what actually exercises the real-world budget difference;
    // an overridden generous budget would make even the OLD buggy
    // implementation wait out the lock correctly, hiding the bug.
    const HOLD_MS = 300;

    it('the force lands AFTER the in-flight tick releases the lock — cursor/itemsSynced stay at the tick\'s fresh values, lastRunAt ends up cleared', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      await state.save({ entity: DELTA_ENTITY, cursor: '14-07-2026', lastRunAt: new Date('2026-07-15T10:00:00Z'), lastResult: 'ok', itemsSynced: 9 });

      const force = new ForceFinanceDeltaRun(state, lock); // DEFAULT budget — the point of this probe

      const tickPromise = simulateInFlightTick(state, lock, HOLD_MS);
      // Give the tick a turn of the event loop to acquire the lock FIRST.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const forcePromise = force.execute();

      const [, forceResult] = await Promise.all([tickPromise, forcePromise]);

      expect(forceResult).toEqual({ started: true });
      const saved = await state.get(DELTA_ENTITY);
      // Mode (A) from the original bug: the force's stale copy would have
      // rewound cursor back to '14-07-2026' and itemsSynced back to 9.
      expect(saved?.cursor).toBe('15-07-2026');
      expect(saved?.itemsSynced).toBe(10);
      // Mode (B) from the original bug: the tick's own save would have
      // overwritten the force's lastRunAt:null, losing the force silently.
      expect(saved?.lastRunAt).toBeNull();
    });

    it('running 5 forced calls concurrently with an in-flight tick never corrupts cursor/itemsSynced', async () => {
      const state = new InMemorySyncStateRepository();
      const lock = new InMemoryDistributedLock();
      await state.save({ entity: DELTA_ENTITY, cursor: '14-07-2026', lastRunAt: new Date('2026-07-15T10:00:00Z'), lastResult: 'ok', itemsSynced: 9 });

      const tickPromise = simulateInFlightTick(state, lock, HOLD_MS);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const forces = Array.from({ length: 5 }, () => new ForceFinanceDeltaRun(state, lock)); // DEFAULT budget

      await Promise.all([tickPromise, ...forces.map((f) => f.execute())]);

      const saved = await state.get(DELTA_ENTITY);
      expect(saved?.cursor).toBe('15-07-2026'); // never rewound, no matter how many forces raced it
      expect(saved?.itemsSynced).toBe(10); // never rewound
      expect(saved?.lastRunAt).toBeNull(); // at least one force landed after the tick
    });
  });
});
