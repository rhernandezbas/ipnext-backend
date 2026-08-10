import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { FinancePaymentReceiptRepository } from '@domain/ports/FinancePaymentReceiptRepository';
import { FinanceReceiptApplicationRepository } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FinanceInvoiceTypeClassificationRepository } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceReceiptSyncConfigRepository } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import { FinanceReceiptRetencionRepository } from '@domain/ports/FinanceReceiptRetencionRepository';
import { previousYearMonth, compareYearMonth, yearMonthToGrRange, arYearMonth, isValidYearMonth } from './financeDates';
import { FinanceReceiptPersistenceError } from './financeIngestErrors';
import { mapAndGuardReceiptPage, persistReceiptPage } from './financeReceiptPageIngest';

const LANE = 'backfill';

/** SyncState entity key for the resumable receipt-backfill watermark. */
const BACKFILL_ENTITY = 'finance-receipts-backfill';
const DEFAULT_PAGE_SIZE = 100;

export interface BackfillPageResult {
  /** Receipts persisted THIS page (includes annulled ones — gr-receipt-annulment stopped excluding them; they're flagged `anulado: true` instead, not skipped). */
  pageProcessed: number;
  /** True when this call moved the cursor to the previous calendar month. */
  monthAdvanced: boolean;
  /** True when the backfill is now fully disarmed (reached the floor and completed it). */
  done: boolean;
}

export interface SyncGrReceiptsBackfillBatchOptions {
  now?: () => Date;
  pageSize?: number;
}

/**
 * Resumable, ONE-GR-PAGE-PER-`execute()` payment-receipt backfill (design.md
 * Decision 4b — deliberate deviation from the `BackfillGrContractsBatch` molde,
 * which drains its whole unit per call). Walks calendar months
 * newest→oldest from the current month down to
 * `FinanceReceiptSyncConfig.backfillFloorYearMonth`, one GR page
 * (`cantidad=pageSize`) per call, so the shared request budget
 * (`FinanceReceiptIngestScheduler`) can interleave it with the delta lane.
 *
 * - Self-arming: unlike `gr-contracts-backfill` (which needs an explicit
 *   `ArmGrContractsBackfill`), the FIRST call (no SyncState row at all) starts
 *   itself at the current calendar month, offset 0 — no separate arm step.
 * - Resumable: cursor `"{yearMonth}:{offset}"` lives entirely in SyncState.
 * - Idempotent: `upsertBatch` on both receipt repos is keyed by id, so a
 *   re-run of the same page is harmless.
 * - No-op when disarmed: a persisted row with `cursor === null` (reached done)
 *   short-circuits with zero GR calls.
 */
export class SyncGrReceiptsBackfillBatch {
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly state: SyncStateRepository,
    private readonly receiptRepo: FinancePaymentReceiptRepository,
    private readonly applicationRepo: FinanceReceiptApplicationRepository,
    private readonly invoiceTypes: FinanceInvoiceTypeClassificationRepository,
    private readonly syncConfig: FinanceReceiptSyncConfigRepository,
    /**
     * fix-wave-3 R9 — MANDATORY, same rationale as `SyncGrReceiptsDelta`:
     * fix-wave-2 R1's optional-and-trailing params were F13's exact footgun
     * reintroduced over the money path — a lost wiring skips SILENTLY
     * (`tsc` green, no test fails, cash-collected metric zeroes out while
     * status stays green). See `SyncGrReceiptsDelta.ts` / `financeIngestErrors.ts`.
     */
    private readonly itemRepo: FinanceReceiptItemRepository,
    private readonly retencionRepo: FinanceReceiptRetencionRepository,
    opts: SyncGrReceiptsBackfillBatchOptions = {},
  ) {
    if (!itemRepo || !retencionRepo) {
      throw new Error(
        'SyncGrReceiptsBackfillBatch: itemRepo and retencionRepo are REQUIRED (fix-wave-3 R9) — omitting them would silently zero the cash-collected metric instead of failing loudly.',
      );
    }
    this.now = opts.now ?? (() => new Date());
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async execute(): Promise<BackfillPageResult> {
    const prior = await this.state.get(BACKFILL_ENTITY);

    // Explicitly disarmed (reached the floor and completed it) → no-op.
    if (prior && prior.cursor === null) {
      return { pageProcessed: 0, monthAdvanced: false, done: true };
    }

    // Self-arm: first call ever (no row) starts at the current month, offset 0.
    let cursorYearMonth: string;
    let cursorOffset: number;
    if (!prior) {
      cursorYearMonth = arYearMonth(this.now());
      cursorOffset = 0;
    } else {
      const parsed = parseCursor(prior.cursor!);
      if (parsed && isValidYearMonth(parsed[0])) {
        [cursorYearMonth, cursorOffset] = parsed;
      } else {
        // fix-wave-1 F14: a corrupted/legacy-shaped cursor (e.g. a flat
        // "2026-03" misread by naive `lastIndexOf` arithmetic as
        // yearMonth="2026-0") is NEVER re-derived into an invalid GR range
        // ("01-00-2026") — reset to a known-sane state (current month)
        // instead of looping on a range GR will keep rejecting.
        console.warn(`[finance-receipts-backfill] corrupt cursor "${prior.cursor}" — resetting to current month`);
        cursorYearMonth = arYearMonth(this.now());
        cursorOffset = 0;
      }
    }

    const { fechaDesde, fechaHasta } = yearMonthToGrRange(cursorYearMonth);

    // fix-wave-1 F5: the ENTIRE run (fetch + persistence + classification) is
    // now inside this try — before the fix, only `gr.fetchReceipts` was
    // guarded, so a throw from `upsertBatch`/`upsertIfAbsent` escaped
    // `execute()` UNCAUGHT and SyncState was never touched (see F4/F5).
    try {
      // fix-wave RF2 (hermano de la lectura del delta) — el `get()` de config
      // vive DENTRO del try: antes estaba afuera, así que un fallo del repo de
      // config escapaba `execute()` sin tocar `SyncState` — exactamente el
      // agujero F5 que este módulo ya cerró para todo lo demás.
      const config = await this.syncConfig.get();
      const page = await this.gr.fetchReceipts({
        fechaDesde,
        fechaHasta,
        cantidad: this.pageSize,
        offset: cursorOffset,
      });
      const { total, receipts } = page;

      // fix-wave-1 F12: a page requested WITHIN the reported range that
      // parses to zero receipts is suspicious. Guard is `offset < total`, NOT
      // `total > 0` — a legitimate empty TAIL page (measured: offset=900,
      // total=828) must not warn.
      if (cursorOffset < total && receipts.length === 0) {
        console.warn(
          `[finance-receipts-backfill] suspicious empty page: offset=${cursorOffset} total=${total} yearMonth=${cursorYearMonth} — check field mapping (F1/F2 regression guard)`,
        );
      }

      // gr-receipt-annulment (design.md Decision 4/8) — map + systemic guard,
      // BEFORE any write. The backfill lane already has `syncConfig` wired
      // (it needs `backfillFloorYearMonth`), so — unlike delta — it uses the
      // LIVE, reloadable guard thresholds.
      const mapped = mapAndGuardReceiptPage(receipts, config, LANE, { rango: `${fechaDesde}..${fechaHasta}`, offset: cursorOffset });
      const receiptRows = mapped.map((m) => m.receipt);

      // fix-wave-2 LOW (F3 residual, DEUDA declarada — not fixed, documented):
      // F3 only guards against GR reporting its OWN error with HTTP 200
      // (`root.error != 0` → throw). A 200 response with `error:0` and
      // `resultados`/`total` absent-or-0 is INDISTINGUISHABLE by design from
      // a legitimately empty month — both make `monthExhausted` true and
      // advance the cursor. This is accepted risk, not a bug this fix-wave
      // closes: GR gives no other signal to tell "genuinely empty month"
      // apart from "GR silently returned nothing for a reason". F12's
      // suspicious-empty-page warning does NOT catch this case either
      // (`total` itself is 0, so `offset < total` is false — no warning).
      const monthExhausted = cursorOffset + this.pageSize >= total;
      const itemsSynced = (prior?.itemsSynced ?? 0) + receiptRows.length;

      // fix-wave-3 R8 / gr-receipt-annulment Decision 8 — everything from
      // here on is PERSISTENCE, never the GR fetch itself. Same rationale as
      // `SyncGrReceiptsDelta` — see `financeIngestErrors.ts`.
      let outcome: BackfillPageResult;
      try {
        await persistReceiptPage(
          mapped,
          { receiptRepo: this.receiptRepo, applicationRepo: this.applicationRepo, itemRepo: this.itemRepo, retencionRepo: this.retencionRepo, invoiceTypes: this.invoiceTypes, syncState: this.state },
          LANE,
          this.now(),
        );

        if (monthExhausted && compareYearMonth(cursorYearMonth, config.backfillFloorYearMonth) <= 0) {
          await this.state.save({
            entity: BACKFILL_ENTITY,
            cursor: null,
            lastRunAt: this.now(),
            lastResult: 'done',
            itemsSynced,
          });
          outcome = { pageProcessed: receiptRows.length, monthAdvanced: false, done: true };
        } else if (monthExhausted) {
          const nextMonth = previousYearMonth(cursorYearMonth);
          await this.state.save({
            entity: BACKFILL_ENTITY,
            cursor: `${nextMonth}:0`,
            lastRunAt: this.now(),
            lastResult: `month ok @${cursorYearMonth}`,
            itemsSynced,
          });
          outcome = { pageProcessed: receiptRows.length, monthAdvanced: true, done: false };
        } else {
          const nextOffset = cursorOffset + this.pageSize;
          await this.state.save({
            entity: BACKFILL_ENTITY,
            cursor: `${cursorYearMonth}:${nextOffset}`,
            lastRunAt: this.now(),
            lastResult: `page ok @${nextOffset}`,
            itemsSynced,
          });
          outcome = { pageProcessed: receiptRows.length, monthAdvanced: false, done: false };
        }
      } catch (err) {
        throw err instanceof FinanceReceiptPersistenceError ? err : new FinanceReceiptPersistenceError(err);
      }
      return outcome;
    } catch (err) {
      // The cursor is saved UNCHANGED — a later run retries the exact same page.
      await this.state.save({
        entity: BACKFILL_ENTITY,
        cursor: `${cursorYearMonth}:${cursorOffset}`,
        lastRunAt: this.now(),
        lastResult: `error: ${(err as Error).message}`,
        itemsSynced: prior?.itemsSynced ?? 0,
      });
      throw err;
    }
  }
}

/**
 * "{yearMonth}:{offset}" → [yearMonth, offset], or `null` when the cursor has
 * no `:` at all, OR (fix-wave-2 LOW) the offset isn't a valid non-negative
 * integer — `Number(...) || 0` used to silently fold ANY non-numeric or
 * negative offset ("2026-07:-5", "2026-07:garbage") down to `0` instead of
 * flagging the cursor as corrupt, same blind spot F14 already closed for the
 * composite delta cursor (`parseCompositeCursor` in `SyncGrReceiptsDelta.ts`).
 * The CALLER additionally validates `yearMonth` shape via `isValidYearMonth`
 * (fix-wave-1 F14) — this function alone can't tell a truncated "2026-0"
 * apart from a real one, since both split cleanly.
 */
function parseCursor(cursor: string): [string, number] | null {
  const idx = cursor.lastIndexOf(':');
  if (idx === -1) return null;
  const yearMonth = cursor.slice(0, idx);
  const offset = Number(cursor.slice(idx + 1));
  if (!Number.isFinite(offset) || offset < 0) return null;
  return [yearMonth, offset];
}
