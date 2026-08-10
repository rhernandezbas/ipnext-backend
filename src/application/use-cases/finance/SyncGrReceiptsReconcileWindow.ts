import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { SyncStateRepository, SyncState } from '@domain/ports/SyncStateRepository';
import { FinancePaymentReceiptRepository } from '@domain/ports/FinancePaymentReceiptRepository';
import { FinanceReceiptApplicationRepository } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FinanceInvoiceTypeClassificationRepository } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceReceiptSyncConfigRepository, FinanceReceiptSyncConfig } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import { FinanceReceiptRetencionRepository } from '@domain/ports/FinanceReceiptRetencionRepository';
import { grDateAr } from './financeDates';
import { FinanceReceiptPersistenceError } from './financeIngestErrors';
import { mapAndGuardReceiptPage, persistReceiptPage } from './financeReceiptPageIngest';
import { MappedGrReceipt } from './mapGrReceipt';
import { deltaCursorHasPendingPages, parseCompositeCursor } from './financeReceiptCursors';

/** SyncState entity key for the reconcile-lane watermark (design.md Decision 2). */
export const RECONCILE_ENTITY = 'finance-receipts-reconcile';
const LANE = 'reconcile';
const DEFAULT_PAGE_SIZE = 100;

export interface ReconcilePageResult {
  /** Receipts persisted THIS page. */
  pageProcessed: number;
  /** True when the current window sweep still has unpaged pages (cursor stayed composite). */
  sweepInProgress: boolean;
  /** The window this call ran against, or null when it was a cadence no-op (zero GR calls). */
  windowFrom: string | null;
  windowTo: string | null;
}

export interface SyncGrReceiptsReconcileWindowOptions {
  now?: () => Date;
  pageSize?: number;
}

/**
 * gr-receipt-annulment (design.md Decisions 1/2/8/9) — third ingest lane:
 * re-consults GR over a MOVING window `reconcileWindowDays` days back, one
 * page per `execute()`, catching receipts the delta lane's overlap window
 * missed (confirmed late) AND real annulments GR reports on a re-consulted
 * receipt.
 *
 * Cursor codec is the SAME composite `"{fechaDesde}:{fechaHasta}:{offset}"`
 * as the delta lane (`financeReceiptCursors.ts` — one implementation, shared),
 * with two deliberate differences from delta:
 *
 * 1. **Never collapses to a plain date.** A closed sweep is `cursor: null` —
 *    delta's collapse-to-flat-date is exactly the mechanism that causes the
 *    late-confirmation bug this lane exists to repair; reusing it here would
 *    reintroduce the same hole one layer up.
 * 2. **The window is computed ONCE, when a sweep STARTS**, and FROZEN in the
 *    cursor for every subsequent page of that same sweep — even if the clock
 *    crosses AR midnight mid-sweep. Re-deriving the window per page would let
 *    GR's reported `total` shift mid-paginate and silently skip/duplicate
 *    receipts.
 */
export class SyncGrReceiptsReconcileWindow {
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly state: SyncStateRepository,
    private readonly receiptRepo: FinancePaymentReceiptRepository,
    private readonly applicationRepo: FinanceReceiptApplicationRepository,
    private readonly invoiceTypes: FinanceInvoiceTypeClassificationRepository,
    private readonly syncConfig: FinanceReceiptSyncConfigRepository,
    /** design.md Decision 8 — MANDATORY, same R9 criterion as delta/backfill: a lost wiring must fail to compile/throw, never silently zero the cash metric. */
    private readonly itemRepo: FinanceReceiptItemRepository,
    private readonly retencionRepo: FinanceReceiptRetencionRepository,
    opts: SyncGrReceiptsReconcileWindowOptions = {},
  ) {
    if (!itemRepo || !retencionRepo) {
      throw new Error(
        'SyncGrReceiptsReconcileWindow: itemRepo and retencionRepo are REQUIRED (design.md Decision 8, R9 criterion) — omitting them would silently zero the cash-collected metric instead of failing loudly.',
      );
    }
    this.now = opts.now ?? (() => new Date());
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async execute(): Promise<ReconcilePageResult> {
    const prior = await this.state.get(RECONCILE_ENTITY);
    const cfg = await this.syncConfig.get();

    const noop: ReconcilePageResult = { pageProcessed: 0, sweepInProgress: false, windowFrom: null, windowTo: null };

    if (!cfg.reconcileEnabled) return noop;
    if (!isReconcileDue(cfg, prior, this.now())) return noop;

    let fechaDesde: string;
    let fechaHasta: string;
    let offset: number;

    if (prior?.cursor && deltaCursorHasPendingPages(prior.cursor)) {
      const parsed = parseCompositeCursor(prior.cursor);
      if (parsed) {
        ({ fechaDesde, fechaHasta, offset } = parsed);
      } else {
        console.warn(`[finance-receipts-reconcile] corrupt cursor "${prior.cursor}" — recalculating window from scratch`);
        ({ fechaDesde, fechaHasta } = this.computeWindow(cfg));
        offset = 0;
      }
    } else {
      // New sweep: never ran, OR the previous sweep closed (cursor null) and
      // the cadence elapsed (already checked by `isReconcileDue` above).
      ({ fechaDesde, fechaHasta } = this.computeWindow(cfg));
      offset = 0;
    }

    try {
      const page = await this.gr.fetchReceipts({ fechaDesde, fechaHasta, cantidad: this.pageSize, offset });
      const { total, receipts } = page;

      // Same F12 guard as delta/backfill — a page requested WITHIN the
      // reported range that parses to zero receipts is suspicious.
      if (offset < total && receipts.length === 0) {
        console.warn(
          `[finance-receipts-reconcile] suspicious empty page: offset=${offset} total=${total} range=${fechaDesde}..${fechaHasta} — check field mapping (F1/F2 regression guard)`,
        );
      }

      const mapped = mapAndGuardReceiptPage(receipts, cfg, LANE);
      const receiptIds = mapped.map((m) => m.receipt.grReceiptId);
      // design.md Decision 9 — "nuevos=" observability: which of this page's
      // ids the mirror did NOT already have BEFORE this sweep persists it —
      // the metric that makes the reconcile window's dimensioning falsifiable.
      const existingBefore = await this.receiptRepo.existingIds(receiptIds);
      const nuevos = mapped.filter((m) => !existingBefore.has(m.receipt.grReceiptId));
      const anuladosCount = mapped.filter((m) => m.receipt.anulado).length;

      const itemsSynced = (prior?.itemsSynced ?? 0) + mapped.length;
      const hasPendingPages = offset + this.pageSize < total;

      try {
        await persistReceiptPage(
          mapped,
          { receiptRepo: this.receiptRepo, applicationRepo: this.applicationRepo, itemRepo: this.itemRepo, retencionRepo: this.retencionRepo, invoiceTypes: this.invoiceTypes },
          LANE,
        );

        if (hasPendingPages) {
          await this.state.save({
            entity: RECONCILE_ENTITY,
            cursor: `${fechaDesde}:${fechaHasta}:${offset + this.pageSize}`,
            lastRunAt: this.now(),
            lastResult: `page ok @${offset + this.pageSize}`,
            itemsSynced,
          });
        } else {
          await this.state.save({
            entity: RECONCILE_ENTITY,
            cursor: null,
            lastRunAt: this.now(),
            lastResult: `sweep ok ${fechaDesde}..${fechaHasta}`,
            itemsSynced,
          });
        }
      } catch (err) {
        throw err instanceof FinanceReceiptPersistenceError ? err : new FinanceReceiptPersistenceError(err);
      }

      this.logPageObservability(offset, nuevos, anuladosCount, cfg.reconcileWindowDays);
      if (!hasPendingPages) {
        console.log(`[finance-receipts-reconcile] sweep ok ${fechaDesde}..${fechaHasta}`);
      }

      return { pageProcessed: mapped.length, sweepInProgress: hasPendingPages, windowFrom: fechaDesde, windowTo: fechaHasta };
    } catch (err) {
      await this.state.save({
        entity: RECONCILE_ENTITY,
        cursor: `${fechaDesde}:${fechaHasta}:${offset}`,
        lastRunAt: this.now(),
        lastResult: `error: ${(err as Error).message}`,
        itemsSynced: prior?.itemsSynced ?? 0,
      });
      throw err;
    }
  }

  /** design.md Decision 2 — `fechaHasta = today`, `fechaDesde = today - (windowDays-1)`, counting days INCLUSIVE of today. */
  private computeWindow(cfg: FinanceReceiptSyncConfig): { fechaDesde: string; fechaHasta: string } {
    const nowDate = this.now();
    const fechaHasta = grDateAr(nowDate);
    const fechaDesde = grDateAr(new Date(nowDate.getTime() - (cfg.reconcileWindowDays - 1) * 24 * 60 * 60 * 1000));
    return { fechaDesde, fechaHasta };
  }

  /** design.md Decision 9 — the falsifiability metric: WARN when the oldest newly-caught receipt sits within 3 days of the window's edge (the window may be too short). */
  private logPageObservability(offset: number, nuevos: MappedGrReceipt[], anuladosCount: number, windowDays: number): void {
    let masViejoReparado: number | null = null;
    for (const m of nuevos) {
      if (!m.receipt.fechaRecibo) continue;
      const ageDays = Math.floor((this.now().getTime() - m.receipt.fechaRecibo.getTime()) / (24 * 60 * 60 * 1000));
      if (masViejoReparado === null || ageDays > masViejoReparado) masViejoReparado = ageDays;
    }
    const ageLabel = masViejoReparado === null ? 'n/a' : `+${masViejoReparado}d`;
    console.log(`[finance-receipts-reconcile] page ok @${offset} nuevos=${nuevos.length} anulados=${anuladosCount} masViejoReparado=${ageLabel}`);
    if (masViejoReparado !== null && masViejoReparado >= windowDays - 3) {
      console.warn(
        `[finance-receipts-reconcile] WARN masViejoReparado=${masViejoReparado}d is within 3 days of the window edge (${windowDays}d) — reconcileWindowDays may be too short, consider raising it.`,
      );
    }
  }
}

/**
 * design.md Decision 2 — cycle table:
 *  - never ran (`!prior`): due.
 *  - a sweep in progress (composite cursor): due (has pending pages).
 *  - a closed sweep (`cursor: null`): due once `reconcileCheckIntervalMs` has
 *    elapsed since `lastRunAt`.
 * `reconcileEnabled: false` is checked by the CALLER (both the use case
 * itself and `FinanceReceiptIngestScheduler`'s arbitration) — kept out of
 * this function so it stays a pure function of "is there work due", not the
 * kill-switch.
 */
export function isReconcileDue(
  cfg: Pick<FinanceReceiptSyncConfig, 'reconcileCheckIntervalMs'>,
  prior: SyncState | null,
  now: Date,
): boolean {
  if (!prior) return true;
  if (prior.cursor && deltaCursorHasPendingPages(prior.cursor)) return true;
  if (!prior.lastRunAt) return true;
  return now.getTime() - prior.lastRunAt.getTime() >= cfg.reconcileCheckIntervalMs;
}
