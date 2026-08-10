import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { FinancePaymentReceiptRepository } from '@domain/ports/FinancePaymentReceiptRepository';
import { FinanceReceiptApplicationRepository } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FinanceInvoiceTypeClassificationRepository } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import { FinanceReceiptRetencionRepository } from '@domain/ports/FinanceReceiptRetencionRepository';
import { FinanceReceiptSyncConfigRepository } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { grDateAr, isValidGrDate } from './financeDates';
import { FinanceReceiptPersistenceError, FinanceReceiptAnnulmentGuardError } from './financeIngestErrors';
import { mapAndGuardReceiptPage, persistReceiptPage } from './financeReceiptPageIngest';
import { GUARD_ABORT_ABANDON_THRESHOLD, recordGuardAbort, clearGuardAbortStreak } from './financeGuardAbortStreak';
import { deltaCursorHasPendingPages, parseCompositeCursor } from './financeReceiptCursors';

/**
 * Re-exported so existing call sites (`FinanceReceiptIngestScheduler`,
 * `GetFinanceSyncStatus`) that import `deltaCursorHasPendingPages` FROM this
 * module keep working unchanged. The real implementation moved to
 * `financeReceiptCursors.ts` (design.md Decision 2) — the reconcile lane
 * needs the identical codec, and duplicating it would be exactly the "test
 * certifies the canonical, prod runs the other" trap.
 */
export { deltaCursorHasPendingPages };

const LANE = 'delta';

/** SyncState entity key for the receipt-delta watermark. */
const DELTA_ENTITY = 'finance-receipts-delta';
const DEFAULT_PAGE_SIZE = 100;

export interface DeltaPageResult {
  /** Receipts persisted THIS page (includes annulled ones — gr-receipt-annulment stopped excluding them; they're flagged `anulado: true` instead, not skipped). */
  pageProcessed: number;
  /** True when the "hasta hoy" range still has unpaged pages left (cursor stayed composite). */
  hasPendingPages: boolean;
  /** The date (DD-MM-AAAA) fully covered once the range collapses, else null. */
  coveredThroughDate: string | null;
}

export interface SyncGrReceiptsDeltaOptions {
  now?: () => Date;
  pageSize?: number;
}

/**
 * Resumable, ONE-GR-PAGE-PER-`execute()` payment-receipt delta sync
 * (design.md Decision 4b — deliberate deviation from
 * `SyncGestionRealContractsDelta`, which drains its whole range per call).
 *
 * Cursor encoding (no precedent exactly like this in the repo, documented in
 * design.md Decision 4b):
 *  - Composite `"{fechaDesde}:{fechaHasta}:{offset}"` while a "hasta hoy" range
 *    still has unpaged pages (`hasPendingPages` is derived from this shape).
 *  - Plain `"{fechaHasta}"` once the range is fully paged — read by the NEXT
 *    run as its `fechaDesde` (overlap of >=1 day, same idiom as
 *    `SyncGestionRealContractsDelta`).
 *
 * First run (no cursor) syncs ONLY today — historical reconstruction is
 * exclusively `SyncGrReceiptsBackfillBatch`'s job.
 */
export class SyncGrReceiptsDelta {
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly state: SyncStateRepository,
    private readonly receiptRepo: FinancePaymentReceiptRepository,
    private readonly applicationRepo: FinanceReceiptApplicationRepository,
    private readonly invoiceTypes: FinanceInvoiceTypeClassificationRepository,
    /**
     * gr-receipt-annulment fix-wave RF2 — the LIVE config, read fresh on every
     * `execute()`. MANDATORY and POSITIONAL, in the SAME slot the backfill and
     * reconcile lanes already put it (hermano alignment: three lanes, one
     * signature shape).
     *
     * Before this fix the delta lane passed
     * `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` to the systemic guard —
     * hardcoded, unreachable from the DB. The stated reason was "not changing
     * the constructor breaks the Fase 9 gate's existing call sites", i.e. a
     * TEST-SHAPE argument deciding production behavior. The consequence was
     * concrete: delta is the lane covering TODAY's cash, so an operator facing
     * a legitimate 6% annulment day (`UPDATE FinanceReceiptSyncConfig SET
     * "annulmentGuardMaxPct" = 15`) would watch the delta keep aborting
     * against the 5% baked into the binary, with today's caja stuck and the
     * knob doing nothing. A knob that cannot be turned in the lane that needs
     * it most is not a knob.
     */
    private readonly syncConfig: FinanceReceiptSyncConfigRepository,
    /**
     * fix-wave-3 R9 — MANDATORY (fix-wave-2 R1 made these optional-and-trailing
     * so ~15 pre-existing call sites kept compiling; that "convenience" was
     * F13's exact footgun reintroduced over the money path: `if (this.itemRepo)
     * await this.itemRepo.upsertBatch(...)` skips SILENTLY when a future
     * refactor loses the wiring — `tsc` still passes (optional param), no test
     * fails (nothing pinned `bootstrapFinanceReceiptsIngest.ts`'s own wiring),
     * no runtime error, and the CASH metric (`items`, spec.md "cash collected"
     * is the base) goes to zero while `itemsSynced`/status stay green.
     * `applicationRepo.listByClientAndMonth` already throws instead of
     * skipping for the exact same reason (F13) — this applies the same
     * criterion to the money path itself. See `financeIngestErrors.ts` /
     * `finance-growth-composition-root.test.ts` for the paired runtime guard
     * + composition-root pin.
     */
    private readonly itemRepo: FinanceReceiptItemRepository,
    private readonly retencionRepo: FinanceReceiptRetencionRepository,
    opts: SyncGrReceiptsDeltaOptions = {},
  ) {
    if (!itemRepo || !retencionRepo) {
      throw new Error(
        'SyncGrReceiptsDelta: itemRepo and retencionRepo are REQUIRED (fix-wave-3 R9) — omitting them would silently zero the cash-collected metric instead of failing loudly.',
      );
    }
    if (!syncConfig) {
      throw new Error(
        'SyncGrReceiptsDelta: syncConfig is REQUIRED (fix-wave RF2) — without it the systemic annulment guard silently runs on hardcoded defaults and the DB knob is inert on the hottest lane.',
      );
    }
    this.now = opts.now ?? (() => new Date());
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async execute(): Promise<DeltaPageResult> {
    const prior = await this.state.get(DELTA_ENTITY);
    const today = grDateAr(this.now());

    let fechaDesde: string;
    let fechaHasta: string;
    let offset: number;

    if (!prior || !prior.cursor) {
      // Bootstrap: no cursor → scan only today.
      fechaDesde = today;
      fechaHasta = today;
      offset = 0;
    } else if (deltaCursorHasPendingPages(prior.cursor)) {
      const parsed = parseCompositeCursor(prior.cursor);
      if (parsed) {
        ({ fechaDesde, fechaHasta, offset } = parsed);
      } else {
        // F14: a corrupted composite cursor is NEVER re-derived into a garbage
        // GR date range — reset to a known-sane state (scan today) instead of
        // looping on a range GR will keep rejecting.
        console.warn(`[finance-receipts-delta] corrupt composite cursor "${prior.cursor}" — resetting to today`);
        fechaDesde = today;
        fechaHasta = today;
        offset = 0;
      }
    } else if (isValidGrDate(prior.cursor)) {
      // Plain cursor = last covered date → re-scan from there through today (overlap).
      fechaDesde = prior.cursor;
      fechaHasta = today;
      offset = 0;
    } else {
      // F14: a corrupted/legacy-shaped plain cursor — same reset as above.
      console.warn(`[finance-receipts-delta] corrupt plain cursor "${prior.cursor}" — resetting to today`);
      fechaDesde = today;
      fechaHasta = today;
      offset = 0;
    }

    /** fix-wave-2 RFX3 (hermano del reconcile) — the RANGE the guard-abort streak belongs to. */
    const sweepKey = `${fechaDesde}..${fechaHasta}`;

    // fix-wave-1 F5: the ENTIRE run (fetch + persistence + classification) is
    // now inside this try — before the fix, only `gr.fetchReceipts` was
    // guarded, so a throw from `upsertBatch`/`upsertIfAbsent` escaped
    // `execute()` UNCAUGHT and SyncState was never touched (the delta looked
    // frozen-healthy forever while actually dead — see F4/F5).
    try {
      // fix-wave RF2 — LIVE config, re-read every run (same as the scheduler's
      // own per-tick read). Inside the `try` on purpose: a config-repo failure
      // is recorded in `SyncState` like any other run failure instead of
      // escaping `execute()` uncaught and leaving the lane looking
      // frozen-healthy (the F5 failure mode).
      const cfg = await this.syncConfig.get();
      const page = await this.gr.fetchReceipts({ fechaDesde, fechaHasta, cantidad: this.pageSize, offset });
      const { total, receipts } = page;

      // fix-wave-1 F12: a page requested WITHIN the reported range that
      // parses to zero receipts is suspicious (the exact failure mode F1/F2
      // produced silently). Guard is `offset < total`, NOT `total > 0` — a
      // legitimate empty TAIL page (measured: offset=900, total=828) must not warn.
      if (offset < total && receipts.length === 0) {
        console.warn(
          `[finance-receipts-delta] suspicious empty page: offset=${offset} total=${total} range=${fechaDesde}..${fechaHasta} — check field mapping (F1/F2 regression guard)`,
        );
      }

      // gr-receipt-annulment (design.md Decision 4/8) — map + systemic guard,
      // BEFORE any write, with the LIVE thresholds (fix-wave RF2): Decision
      // 4's "los tres carriles" is now literally true, no narrowing.
      const mapped = mapAndGuardReceiptPage(receipts, cfg, LANE, { rango: `${fechaDesde}..${fechaHasta}`, offset });
      const receiptRows = mapped.map((m) => m.receipt);

      const itemsSynced = (prior?.itemsSynced ?? 0) + receiptRows.length;
      const hasPendingPages = offset + this.pageSize < total;

      // fix-wave-3 R8 / gr-receipt-annulment Decision 8 — everything from
      // here on is PERSISTENCE (repo writes + classification + the
      // success-path SyncState.save), never the GR fetch itself.
      // `persistReceiptPage` already wraps its own failures as
      // `FinanceReceiptPersistenceError`; this catch only needs to wrap
      // whatever ELSE can fail in this block (the `state.save` call) without
      // double-wrapping an already-wrapped error — so
      // `FinanceReceiptIngestScheduler` can tell "GR is unwell" apart from "a
      // repo write failed while GR was perfectly healthy" (see
      // `financeIngestErrors.ts`). The outer catch below still records
      // `lastResult: error:` in SyncState regardless of which one this is —
      // that observability is unchanged.
      try {
        await persistReceiptPage(
          mapped,
          { receiptRepo: this.receiptRepo, applicationRepo: this.applicationRepo, itemRepo: this.itemRepo, retencionRepo: this.retencionRepo, invoiceTypes: this.invoiceTypes, syncState: this.state },
          LANE,
          this.now(),
        );

        if (hasPendingPages) {
          await this.state.save({
            entity: DELTA_ENTITY,
            cursor: `${fechaDesde}:${fechaHasta}:${offset + this.pageSize}`,
            lastRunAt: this.now(),
            lastResult: `page ok @${offset + this.pageSize}`,
            itemsSynced,
          });
        } else {
          await this.state.save({
            entity: DELTA_ENTITY,
            cursor: fechaHasta,
            lastRunAt: this.now(),
            lastResult: 'ok',
            itemsSynced,
          });
        }

        // fix-wave-2 RFX3 — a page through the guard breaks the streak.
        await clearGuardAbortStreak(this.state, DELTA_ENTITY, this.now());
      } catch (err) {
        throw err instanceof FinanceReceiptPersistenceError ? err : new FinanceReceiptPersistenceError(err);
      }

      if (hasPendingPages) {
        return { pageProcessed: receiptRows.length, hasPendingPages: true, coveredThroughDate: null };
      }
      return { pageProcessed: receiptRows.length, hasPendingPages: false, coveredThroughDate: fechaHasta };
    } catch (err) {
      // fix-wave RF4 (hermano del reconcile) — a systemic-guard abort pins the
      // COMPOSITE cursor, and a composite cursor makes this lane "due" on every
      // single tick: the same poisoned page is re-requested forever, with no
      // backoff and no way out. Identical structure, identical fix: after
      // `GUARD_ABORT_ABANDON_THRESHOLD` consecutive aborts the lane gives the
      // range up and COLLAPSES the cursor to `fechaDesde` — the plain form,
      // which claims coverage of NOTHING new (the next run re-scans
      // `[fechaDesde, hoy]` from offset 0) and restores the normal
      // `deltaCheckIntervalMs` cadence instead of every-tick hammering.
      //
      // Deliberately NOT mirrored on the backfill lane: there, "abandoning"
      // would mean skipping a month's page permanently — unrecoverable history
      // loss. Delta and reconcile both re-scan overlapping ranges by design, so
      // giving up on a range costs nothing but a delay.
      //
      // fix-wave-2 RFX3 — same correction as the reconcile hermano: the streak
      // is EXPLICIT persisted state keyed by the range, not a number parsed
      // back out of the last message written. An `ECONNRESET` between two
      // aborts no longer zeroes it, so a flaky GR can no longer keep this lane
      // hammering the same page below the abandon threshold forever.
      if (err instanceof FinanceReceiptAnnulmentGuardError) {
        const streak = await recordGuardAbort(this.state, DELTA_ENTITY, sweepKey, this.now());
        const abandon = streak >= GUARD_ABORT_ABANDON_THRESHOLD;
        await this.state.save({
          entity: DELTA_ENTITY,
          cursor: abandon ? fechaDesde : `${fechaDesde}:${fechaHasta}:${offset}`,
          lastRunAt: this.now(),
          lastResult: abandon
            ? `error: ${err.message} [rango ABANDONADO tras ${streak} aborts consecutivos del guard — reintenta en la cadencia normal]`
            : `error: ${err.message} [aborts consecutivos del guard en este rango: ${streak}]`,
          itemsSynced: prior?.itemsSynced ?? 0,
        });
        if (abandon) {
          await clearGuardAbortStreak(this.state, DELTA_ENTITY, this.now());
          console.error(
            `[finance-receipts-${LANE}] rango ${fechaDesde}..${fechaHasta} ABANDONADO tras ${streak} aborts consecutivos del guard en offset=${offset} — el carril queda degradado y reintenta desde ${fechaDesde} en la próxima cadencia.`,
          );
        }
        throw err;
      }

      await this.state.save({
        entity: DELTA_ENTITY,
        cursor: `${fechaDesde}:${fechaHasta}:${offset}`,
        lastRunAt: this.now(),
        lastResult: `error: ${(err as Error).message}`,
        itemsSynced: prior?.itemsSynced ?? 0,
      });
      throw err;
    }
  }
}
