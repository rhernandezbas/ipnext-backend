import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { FinancePaymentReceiptRepository } from '@domain/ports/FinancePaymentReceiptRepository';
import { FinanceReceiptApplicationRepository } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FinanceInvoiceTypeClassificationRepository } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import { FinanceReceiptRetencionRepository } from '@domain/ports/FinanceReceiptRetencionRepository';
import { FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { grDateAr, isValidGrDate } from './financeDates';
import { FinanceReceiptPersistenceError } from './financeIngestErrors';
import { mapAndGuardReceiptPage, persistReceiptPage } from './financeReceiptPageIngest';

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

    // fix-wave-1 F5: the ENTIRE run (fetch + persistence + classification) is
    // now inside this try — before the fix, only `gr.fetchReceipts` was
    // guarded, so a throw from `upsertBatch`/`upsertIfAbsent` escaped
    // `execute()` UNCAUGHT and SyncState was never touched (the delta looked
    // frozen-healthy forever while actually dead — see F4/F5).
    try {
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
      // BEFORE any write. The delta lane has no `syncConfig` collaborator
      // (deliberate: adding one would change this class's constructor
      // signature, breaking `finance-receipts-ingest-seam.test.ts`'s and
      // `SyncGrReceiptsDelta.test.ts`'s existing call sites — the Fase 9
      // gate this refactor must not touch). The guard still runs on delta
      // using the DEFAULT thresholds (5%/min 5, the SAME values the
      // singleton config row starts with) rather than a live-reloadable
      // config — delta's pages are small ("today" only) and the defaults
      // are already the safe values (design.md Decision 7), so this is a
      // deliberate, documented narrowing of Decision 4's "los tres carriles"
      // for this ONE lane, not a silent skip.
      const mapped = mapAndGuardReceiptPage(receipts, FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS, LANE);
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
        await persistReceiptPage(mapped, { receiptRepo: this.receiptRepo, applicationRepo: this.applicationRepo, itemRepo: this.itemRepo, retencionRepo: this.retencionRepo, invoiceTypes: this.invoiceTypes }, LANE);

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
      } catch (err) {
        throw err instanceof FinanceReceiptPersistenceError ? err : new FinanceReceiptPersistenceError(err);
      }

      if (hasPendingPages) {
        return { pageProcessed: receiptRows.length, hasPendingPages: true, coveredThroughDate: null };
      }
      return { pageProcessed: receiptRows.length, hasPendingPages: false, coveredThroughDate: fechaHasta };
    } catch (err) {
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

/**
 * True when the persisted `finance-receipts-delta` cursor is COMPOSITE
 * ("DD-MM-AAAA:DD-MM-AAAA:offset" — a range still has unpaged pages); false
 * for a plain "DD-MM-AAAA" (fully covered) or a missing cursor. Exported so
 * `FinanceReceiptIngestScheduler` can derive `hasPendingPages` from
 * `SyncStateRepository` WITHOUT re-running the use case (design.md Decision 4b).
 */
export function deltaCursorHasPendingPages(cursor: string | null): boolean {
  return !!cursor && cursor.includes(':');
}

/**
 * Parse a composite `"{fechaDesde}:{fechaHasta}:{offset}"` cursor. Returns
 * `null` (never a garbage-filled object) when the shape is wrong or either
 * date isn't a valid GR "DD-MM-AAAA" — fix-wave-1 F14, the caller resets to a
 * known-sane state instead of building a request GR will reject.
 */
function parseCompositeCursor(cursor: string): { fechaDesde: string; fechaHasta: string; offset: number } | null {
  const parts = cursor.split(':');
  if (parts.length !== 3) return null;
  const [fechaDesde, fechaHasta, offsetStr] = parts as [string, string, string];
  if (!isValidGrDate(fechaDesde) || !isValidGrDate(fechaHasta)) return null;
  const offset = Number(offsetStr);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return { fechaDesde, fechaHasta, offset };
}
