import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { DistributedLock } from '@domain/ports/DistributedLock';
import { FinanceReceiptSyncConfigRepository, FinanceReceiptSyncConfig, FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { SyncGrReceiptsDelta, DeltaPageResult, deltaCursorHasPendingPages } from '@application/use-cases/finance/SyncGrReceiptsDelta';
import { SyncGrReceiptsBackfillBatch, BackfillPageResult } from '@application/use-cases/finance/SyncGrReceiptsBackfillBatch';
import { FinanceReceiptPersistenceError } from '@application/use-cases/finance/financeIngestErrors';
import { FinancePacingStatusDto } from '@application/dto/financeGrowth.dto';

const LOCK_KEY = 'finance-receipts-ingest';
const DELTA_ENTITY = 'finance-receipts-delta';

export interface FinanceReceiptIngestSchedulerOptions {
  /** Suppress console logging (tests). */
  silent?: boolean;
  /** Injectable clock — tests drive `deltaCheckIntervalMs` due-ness without real timers. */
  now?: () => Date;
}

export interface FinanceReceiptIngestTickResult {
  skipped?: boolean;
  error?: string;
  lane?: 'delta' | 'backfill';
  delta?: DeltaPageResult;
  backfill?: BackfillPageResult;
}

/** Re-exported for call sites that only know this scheduler, not the DTO module. */
export type FinanceReceiptIngestSchedulerStatus = FinancePacingStatusDto;

/**
 * Arbiter of the SHARED request budget between the delta lane (recent
 * receipts, ABSOLUTE priority) and the backfill lane (historical,
 * newest→oldest) — design.md Decision 4b. Molde `GestionRealSyncScheduler`
 * for the two-layer overlap guard (`inFlight` + `DistributedLock`), but with
 * a DELIBERATE deviation: `setTimeout` recursive instead of a fixed
 * `setInterval`, because `effectiveIntervalMs` changes dynamically under
 * backoff (`setInterval` can't do that without destroying/recreating the timer).
 *
 * Per tick: the delta lane wins whenever it has pending pages OR its
 * `deltaCheckIntervalMs` elapsed since its last run; the backfill lane gets
 * the turn ONLY when the delta has nothing to do right now — it NEVER
 * delays the delta. `SyncGrReceiptsBackfillBatch.execute()` itself is a
 * cheap no-op once it reaches `done`, so there is no need for the scheduler
 * to separately track "backfill finished".
 */
export class FinanceReceiptIngestScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  /** fix-wave-1 F7 — set by `stop()`; checked both before scheduling AND before running a tick. */
  private stopped = false;
  private tickCount = 0;
  private effectiveIntervalMs = FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs;
  /** fix-wave-1 F6 — last LIVE config read, used by `status` and to seed `scheduleNext()`'s delay. Never frozen at construction. */
  private currentRequestIntervalMs = FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs;
  private currentMaxRequestIntervalMs = FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.maxRequestIntervalMs;
  private currentDeltaStarvationThreshold = FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.deltaStarvationThreshold;
  /**
   * fix-wave-2 R3 — the LIVE `enabled` kill-switch, as last observed by a
   * tick. Optimistic `true` at CONSTRUCTION time (matches the pre-existing
   * bootstrap behavior: the scheduler is only ever constructed when GR itself
   * is on) — this is what a `tick()` called directly, without ever going
   * through `start()`, still sees before its first real config read.
   *
   * fix-wave-4 W3 — `start()` (the REAL boot path, `main.ts`) overrides this
   * to fail-CLOSED (`false`) the moment it runs, precisely because a process
   * restart has no "last observed value" to be optimistic ABOUT: an operator
   * may have set `enabled=false` in the DB specifically for this deploy, and
   * if the very first config read after restart fails (pool exhausted, a
   * timeout — it doesn't need to be fully down), the OLD optimistic-`true`
   * default resumed GR calls against that explicit decision for however long
   * the read stayed broken. See `start()` for the actual override.
   */
  private currentEnabled = true;
  private activeLane: 'delta' | 'backfill' | 'idle' = 'idle';

  // fix-wave-2 R4 — health tracked PER SOURCE. Before this fix, a single
  // SHARED `consecutiveFailures` counter was reset to 0 by ANY tick's
  // success — a healthy backfill tick made a chronically-broken delta lane
  // look "recovered" every other tick (the status oscillated instead of
  // reflecting sustained degradation, and `degraded`/`consecutiveFailures`
  // lied exactly on the case F4's circuit breaker exists to handle).
  private deltaConsecutiveFailures = 0;
  private backfillConsecutiveFailures = 0;
  // fix-wave-2 R5 — scheduler-level infra failures (config read / lock ops),
  // tracked separately from lane health so a config hiccup doesn't get
  // silently absorbed into (or silently absorb) a lane's own failure streak.
  private configConsecutiveFailures = 0;
  private lockConsecutiveFailures = 0;
  /**
   * fix-wave-3 R8 — GR's OWN health signal, tracked SEPARATELY from
   * `deltaConsecutiveFailures`/`backfillConsecutiveFailures`. Before this
   * fix, `refreshEffectiveInterval()` derived the SHARED request-pacing
   * backoff from `Math.max()` of the per-lane counters — ANY lane failure,
   * persistence included. Probed: a single poisoned recibo makes
   * `applicationRepo.upsertBatch` throw on every delta tick while GR is
   * perfectly healthy; after 4 failures the pacing clamped to
   * `maxRequestIntervalMs` (300000ms) FOREVER, taking the healthy backfill
   * lane down with it (~15x slower — see `financeIngestErrors.ts`). Only
   * incremented on a NON-`FinanceReceiptPersistenceError` failure (i.e. the GR
   * fetch itself, or anything upstream of persistence); reset to 0 on ANY
   * lane outcome that proves GR answered THIS tick — a full success, or even
   * a persistence-only failure (the fetch inside that `execute()` call still
   * had to succeed for persistence to be reached at all).
   *
   * Per-lane health (`deltaConsecutiveFailures`/`backfillConsecutiveFailures`,
   * used for `/sync/status` and the F4 starvation circuit breaker) is
   * UNCHANGED — still counts ANY failure, persistence included.
   *
   * fix-wave-4 W1 — "a full success" above is qualified in `runTick()`'s
   * backfill branch: a backfill call that no-ops once fully `done` (ZERO
   * calls to GR) does NOT count as GR "answering this tick" and must NOT
   * reset this counter — see the comment at that reset site.
   */
  private grConsecutiveFailures = 0;

  private readonly now: () => Date;

  constructor(
    private readonly syncDelta: Pick<SyncGrReceiptsDelta, 'execute'>,
    private readonly syncBackfill: Pick<SyncGrReceiptsBackfillBatch, 'execute'>,
    private readonly state: SyncStateRepository,
    private readonly lock: DistributedLock,
    /**
     * fix-wave-1 F6 — read LIVE, every tick, never frozen at boot.
     * `enabled` is a runtime kill-switch: flipping it in the DB actually
     * stops GR calls without a process restart, and `requestIntervalMs`/
     * `maxRequestIntervalMs`/`deltaCheckIntervalMs` take effect on the very
     * next tick.
     */
    private readonly syncConfig: Pick<FinanceReceiptSyncConfigRepository, 'get'>,
    private readonly opts: FinanceReceiptIngestSchedulerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.stopped = false;
    // fix-wave-4 W3 — FAIL-CLOSED at boot. `start()` is the REAL entry point
    // (`main.ts`); a process restart has no "last observed value", so the
    // pre-existing optimistic `true` (kept as-is for direct `tick()` callers,
    // see the field's docblock) must NOT survive here. If the very FIRST
    // tick's own `readConfigSafely()` succeeds, it overwrites this with the
    // REAL DB value immediately — no artificial delay for a healthy boot.
    // It only STAYS `false` when that first read genuinely fails, which is
    // exactly R7's own rule ("a failed read can only ever repeat what was
    // already known") applied to the one case R7 left open: at boot, what
    // was already known is NOTHING, and nothing must mean closed, not open.
    this.currentEnabled = false;
    this.log(`[finance-receipts] started, interval=${this.effectiveIntervalMs}ms`);
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.log('[finance-receipts] stopped');
  }

  /**
   * fix-wave-2 LOW (timer bifurcation) — the SOLE owner of `this.timer`.
   * ALWAYS clears whatever timer is currently armed before replacing it, so
   * overlapping callers (an explicit `start()` call racing an in-flight
   * tick's own `.finally()` re-arm after `stop()`+`start()`, or `start()`
   * called twice) can NEVER leave two live timers armed at once — that was
   * exactly fix-wave-1's leftover gap: `scheduleNext()` overwrote
   * `this.timer` WITHOUT clearing the previous one first, so the old timer
   * kept ticking in the background ⇒ 2× the SHARED GR request budget, a
   * direct violation of the user's "never saturate GR" LOCK decision.
   * `start()` itself needs no separate idempotency guard — clearing-before-
   * set here already makes any number of `scheduleNext()` calls collapse to
   * exactly one live timer, whichever call happened last.
   */
  private scheduleNext(): void {
    // fix-wave-1 F7 — `stop()` may have been called from INSIDE the `.finally()`
    // of an in-flight tick; without this guard the chain re-arms itself even
    // after `stop()` already ran (clearTimeout on a timer that already fired
    // is a no-op, so the flag is the only thing that actually stops it).
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => this.log(`[finance-receipts] tick() rejected unexpectedly: ${(err as Error).message}`))
        .finally(() => this.scheduleNext());
    }, this.effectiveIntervalMs);
    // Don't keep the event loop alive just for this timer.
    if (this.timer.unref) this.timer.unref();
  }

  async tick(): Promise<FinanceReceiptIngestTickResult> {
    // fix-wave-1 F7 — a tick that fires after `stop()` (already scheduled
    // before the stop) must also no-op, not just skip re-scheduling.
    if (this.stopped) {
      return { skipped: true };
    }

    // Layer 1: intra-process guard (no I/O, cheap). fix-wave-1 LOW/TOCTOU —
    // `inFlight` is set TRUE synchronously, IMMEDIATELY after this check and
    // BEFORE any `await`. The previous code checked-then-awaited-then-set,
    // leaving a window where two ticks fired back-to-back could both cross
    // this check while it was still false. This matters because Layer 2
    // (`PgAdvisoryLock`) is RE-ENTRANT within the SAME connection/process —
    // it does NOT protect against two concurrent ticks from this same
    // scheduler instance, only against a DIFFERENT replica.
    if (this.inFlight) {
      this.log('[finance-receipts] skipped — previous tick still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    try {
      // fix-wave-1 F6 — read the pacing/kill-switch config LIVE, every tick.
      // fix-wave-2 R5 — a config-repo failure no longer escapes `tick()`
      // uncaught (see `readConfigSafely`): it falls back to defaults (with a
      // WARNING) and is tracked as its own failure source instead of
      // silently killing the whole tick chain via an unhandled rejection.
      const cfg = await this.readConfigSafely();
      this.currentRequestIntervalMs = cfg.requestIntervalMs;
      this.currentMaxRequestIntervalMs = cfg.maxRequestIntervalMs;
      this.currentDeltaStarvationThreshold = cfg.deltaStarvationThreshold;
      // fix-wave-2 R3 — updated on EVERY tick, whether or not the tick goes
      // on to actually run a lane; this is what `isEnabled()`/the route's
      // 503 guard consult.
      this.currentEnabled = cfg.enabled;
      this.refreshEffectiveInterval();

      if (!cfg.enabled) {
        this.log('[finance-receipts] skipped — disabled via FinanceReceiptSyncConfig.enabled=false');
        return { skipped: true };
      }

      // Layer 2: distributed guard (cross-replica). A held lock is a no-op —
      // NOT a failure — so it never triggers backoff (design.md Decision 4b).
      let acquired: boolean;
      try {
        acquired = await this.lock.tryAcquire(LOCK_KEY);
        this.lockConsecutiveFailures = 0;
      } catch (err) {
        // fix-wave-2 R5 — a lock-acquire failure is a REAL infra failure
        // (unlike "lock held elsewhere"), tracked and reflected in backoff —
        // before this fix it escaped `tick()` uncaught, same failure mode as
        // the config-read case.
        this.lockConsecutiveFailures++;
        this.refreshEffectiveInterval();
        const message = (err as Error).message;
        this.log(`[finance-receipts] ERROR — lock acquire failed (backoff → ${this.effectiveIntervalMs}ms): ${message}`);
        return { error: message };
      }
      if (!acquired) {
        this.log('[finance-receipts] skipped — lock held by another instance');
        return { skipped: true };
      }

      try {
        return await this.runTick(cfg.deltaCheckIntervalMs);
      } finally {
        try {
          await this.lock.release(LOCK_KEY);
        } catch (err) {
          this.lockConsecutiveFailures++;
          this.refreshEffectiveInterval();
          this.log(`[finance-receipts] WARNING — lock release failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * fix-wave-2 R5 — applies F5's principle to the SCHEDULER itself: any
   * failure reading the pacing config falls back to
   * `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` (with a WARNING) instead of
   * letting the exception escape `tick()` uncaught. Before this fix,
   * `await this.syncConfig.get()` had no try/catch at all — a `tick()`
   * rejection was consumed by `scheduleNext`'s `void this.tick().finally(...)`
   * WITHOUT a `.catch`, landing in `main.ts`'s process-wide
   * `unhandledRejection` handler (doesn't crash, but `onTickFailure` never
   * ran): no backoff, no `consecutiveFailures`, no `lastResult` — the
   * scheduler would hammer a DOWN config repo every tick with the status
   * dashboard still showing green.
   */
  private async readConfigSafely(): Promise<FinanceReceiptSyncConfig> {
    try {
      const cfg = await this.syncConfig.get();
      this.configConsecutiveFailures = 0;
      return cfg;
    } catch (err) {
      this.configConsecutiveFailures++;
      this.log(`[finance-receipts] WARNING — FinanceReceiptSyncConfig read failed, falling back to defaults: ${(err as Error).message}`);
      // fix-wave-3 R7 — ASYMMETRIC fallback. Pacing knobs
      // (requestIntervalMs/maxRequestIntervalMs/deltaCheckIntervalMs/
      // deltaStarvationThreshold) are safe to fall back to the DEFAULTS. But
      // `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.enabled` is `true` — spreading
      // the whole defaults object here (as before) reopened EXACTLY the bug
      // R3 closed: an operator sets `enabled=false` (the kill-switch), THIS
      // read then merely hiccups (a query timeout, a locked row — the DB
      // doesn't need to be fully down), and the fallback silently flips
      // `enabled` back to `true` — resuming GR calls against the operator's
      // explicit decision, with `/sync/status`/`isEnabled()` lying in the one
      // field R3 added so they wouldn't. `enabled` must instead carry over
      // `this.currentEnabled` — the LAST value a successful read actually
      // observed (optimistic `true` before the very first ever successful
      // read, same default R3 already documented) — so a failed read can only
      // ever repeat what was already known, never invent a "resumed" state.
      return { ...FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS, enabled: this.currentEnabled };
    }
  }

  /** The actual delta-vs-backfill arbitration + execution, ALWAYS called with both guards already held. */
  private async runTick(deltaCheckIntervalMs: number): Promise<FinanceReceiptIngestTickResult> {
    this.tickCount++;
    try {
      const deltaDue = await this.isDeltaDue(deltaCheckIntervalMs);
      // fix-wave-1 F4 — once the delta has failed `deltaStarvationThreshold`
      // times in a row, it no longer gets EVERY tick just by being "due": the
      // scheduler alternates with the backfill lane (odd ticks still retry
      // delta so it can recover immediately; even ticks give backfill the
      // turn so history keeps progressing instead of sitting at zero).
      const starved = this.deltaConsecutiveFailures >= this.currentDeltaStarvationThreshold;
      const runDelta = deltaDue && !(starved && this.tickCount % 2 === 0);

      if (runDelta) {
        let delta: DeltaPageResult;
        try {
          delta = await this.syncDelta.execute();
        } catch (err) {
          this.deltaConsecutiveFailures++;
          this.trackGrHealth(err);
          throw err;
        }
        this.deltaConsecutiveFailures = 0;
        this.grConsecutiveFailures = 0;
        this.activeLane = 'delta';
        this.refreshEffectiveInterval();
        this.log(`[finance-receipts] delta: +${delta.pageProcessed}${delta.hasPendingPages ? ' (pending)' : ''}`);
        return { lane: 'delta', delta };
      }

      let backfill: BackfillPageResult;
      try {
        backfill = await this.syncBackfill.execute();
      } catch (err) {
        this.backfillConsecutiveFailures++;
        this.trackGrHealth(err);
        throw err;
      }
      this.backfillConsecutiveFailures = 0;
      // fix-wave-4 W1 — R8 reset `grConsecutiveFailures` on ANY backfill
      // "success", including the no-op it returns once fully `done`
      // (`SyncGrReceiptsBackfillBatch.execute()`'s early return when a prior
      // row already has `cursor === null` — ZERO calls to `gr.fetchReceipts`).
      // Probed: backfill steady-state `done` (~4 days post-deploy) + delta
      // genuinely down ⇒ every OTHER tick (the F4-alternation turn backfill
      // gets) falsely "proves GR healthy" via a call that never touched GR,
      // oscillating the shared backoff 20s<->40s FOREVER instead of escalating
      // to `maxRequestIntervalMs` — ~10x more requests against a downed GR.
      // `pageProcessed > 0 || monthAdvanced` is true for every outcome that
      // DID reach `gr.fetchReceipts` (including the one-time transition call
      // that finishes the backfill on THIS tick — `done: true`, but with rows
      // processed or a month boundary crossed); only the true no-op shape
      // (`pageProcessed: 0, monthAdvanced: false, done: true`) is excluded,
      // with no change to `BackfillPageResult`'s shape.
      if (!backfill.done || backfill.pageProcessed > 0 || backfill.monthAdvanced) {
        this.grConsecutiveFailures = 0;
      }
      this.activeLane = 'backfill';
      this.refreshEffectiveInterval();
      this.log(`[finance-receipts] backfill: +${backfill.pageProcessed}${backfill.done ? ' (done)' : ''}`);
      return { lane: 'backfill', backfill };
    } catch (err) {
      // fix-wave-2 R4 LOW — a failed tick must not keep reporting the LAST
      // successful lane as if it were still healthy; the only trustworthy
      // "sano" signal at that point is `lastResult` per-lane on /sync/status.
      this.activeLane = 'idle';
      this.refreshEffectiveInterval();
      const message = (err as Error).message;
      this.log(`[finance-receipts] ERROR (backoff → ${this.effectiveIntervalMs}ms): ${message}`);
      return { error: message };
    }
  }

  /**
   * fix-wave-3 R8 — the ONLY place `grConsecutiveFailures` is incremented.
   * `FinanceReceiptPersistenceError` means the GR fetch inside that
   * `execute()` call already succeeded (persistence failed AFTER it) — GR
   * itself is proven healthy THIS tick, so this RESETS the streak instead of
   * growing it. Any other error (the fetch itself, or anything upstream of
   * persistence) is attributed to GR and grows the streak.
   */
  private trackGrHealth(err: unknown): void {
    if (err instanceof FinanceReceiptPersistenceError) {
      this.grConsecutiveFailures = 0;
    } else {
      this.grConsecutiveFailures++;
    }
  }

  /** Delta wins whenever it has pending pages, or its check interval elapsed since the last run. */
  private async isDeltaDue(deltaCheckIntervalMs: number): Promise<boolean> {
    const deltaState = await this.state.get(DELTA_ENTITY);
    if (!deltaState) return true; // never ran → bootstrap
    if (deltaCursorHasPendingPages(deltaState.cursor)) return true;
    if (!deltaState.lastRunAt) return true;
    return this.now().getTime() - deltaState.lastRunAt.getTime() >= deltaCheckIntervalMs;
  }

  /**
   * fix-wave-2 R4 — `consecutiveFailures`/`degraded` on `/sync/status` (and
   * the F4 starvation threshold, via `deltaConsecutiveFailures` directly)
   * derive from the WORST currently-open failure streak across BOTH lanes AND
   * scheduler-level infra (config/lock) — a single shared counter reset by
   * ANY success would let one source's recovery silently mask another's
   * sustained failure.
   *
   * fix-wave-3 R8 — `effectiveIntervalMs` (the SHARED request-pacing backoff
   * actually applied to GR) is DELIBERATELY narrower: it derives from
   * `grConsecutiveFailures` (GR's own fetch health) plus the scheduler-level
   * infra streaks (config/lock — R5, unrelated to lane content), but NEVER
   * from the per-lane `deltaConsecutiveFailures`/`backfillConsecutiveFailures`
   * directly. A lane failing on PERSISTENCE (GR itself healthy) must not slow
   * down the shared request rhythm — see `financeIngestErrors.ts` for the
   * probe this closes. Splitting these two derivations is the fix: before
   * fix-wave-3, both used the same `worstConsecutiveFailures()`.
   */
  private refreshEffectiveInterval(): void {
    const pacingWorst = Math.max(this.grConsecutiveFailures, this.configConsecutiveFailures, this.lockConsecutiveFailures);
    this.effectiveIntervalMs =
      pacingWorst === 0
        ? this.currentRequestIntervalMs
        : Math.min(this.currentRequestIntervalMs * 2 ** pacingWorst, this.currentMaxRequestIntervalMs);
  }

  private worstConsecutiveFailures(): number {
    return Math.max(
      this.deltaConsecutiveFailures,
      this.backfillConsecutiveFailures,
      this.configConsecutiveFailures,
      this.lockConsecutiveFailures,
    );
  }

  get status(): FinancePacingStatusDto {
    const consecutiveFailures = this.worstConsecutiveFailures();
    return {
      requestIntervalMs: this.currentRequestIntervalMs,
      effectiveIntervalMs: this.effectiveIntervalMs,
      degraded: consecutiveFailures > 0,
      consecutiveFailures,
      activeLane: this.activeLane,
      enabled: this.currentEnabled,
    };
  }

  /**
   * fix-wave-2 R3 — the LIVE signal of "will a tick actually pick this up",
   * consulted by the route's 503 guard for `POST /sync/run`. Reflects BOTH
   * the `FinanceReceiptSyncConfig.enabled` kill-switch (as last observed by
   * a tick — F6 rereads it every tick, never frozen at boot) AND `stop()` (a
   * stopped scheduler will never tick again, no matter what the DB says).
   * Mere EXISTENCE of the scheduler object (fix-wave-1 F8's original check,
   * `!= null`) stopped being a reliable signal once F6 removed the boot-time
   * `enabled` gate from `bootstrapFinanceReceiptsIngest.ts` — the object now
   * ALWAYS exists whenever GR itself is on, regardless of the DB kill-switch.
   */
  isEnabled(): boolean {
    return !this.stopped && this.currentEnabled;
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}
