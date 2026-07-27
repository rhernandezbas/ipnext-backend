import type { BuildFinanceMonthlySnapshot } from '@application/use-cases/finance/BuildFinanceMonthlySnapshot';
import type { BuildFinanceCohortSnapshot } from '@application/use-cases/finance/BuildFinanceCohortSnapshot';
import { isValidYearMonth, compareYearMonth, addMonthsToYearMonth, arYearMonth } from '@application/use-cases/finance/financeDates';

const MAX_MONTHS_PER_RUN = 240; // 20 years — generous cap against a fat-fingered range accidentally walking centuries

export interface BackfillFinanceMonthlySnapshotsResult {
  monthsComputed: string[];
  monthsFailed: Array<{ yearMonth: string; error: string }>;
}

/**
 * finance-growth Fase 3 rework (J1) — "the job only ever builds
 * current+previous month, forever": `FinanceSnapshotScheduler`
 * (design.md Wiring) deliberately recomputes only a 2-month rolling window
 * every night (see its own docblock) — by design, NOT a bug on its own.
 * But with NO other call site, `FinanceMonthlySnapshot` would have rows
 * ONLY for the last 2 months FOREVER, even once Fase 1's receipt backfill
 * brings in 163 months of history — `GetFinanceOverview` (Fase 4) would
 * read an EMPTY table for any older range. The retroactive MRR bridge — the
 * entire reason this change exists — would never come to exist.
 *
 * This use case is the missing manual trigger: given an explicit
 * `[fromYearMonth, toYearMonth]` range, it walks forward (oldest→newest,
 * ascending) computing BOTH the monthly snapshot and the cohort snapshot for
 * every month in the range. Ascending order matters for `BuildFinanceCohortSnapshot`
 * ONLY in spirit (each month's cohort computation is independent — see that
 * class's docblock), but for `BuildFinanceMonthlySnapshot` it's now
 * IRRELEVANT to correctness (the Fase 3 rework made every month
 * independently computable — `mrrInicialArs` is derived fresh from event
 * history every run, never chained from a stored previous snapshot, see
 * that class's docblock "how the bridge closes"). Ascending order is kept
 * anyway because it reads naturally in logs/progress reporting.
 *
 * One month failing (e.g. a transient repo error) does NOT abort the rest
 * of the range — same resilience criterion as `FinanceSnapshotScheduler.runOnce()`.
 *
 * Scope note (deliberately NOT built here): this is a synchronous,
 * one-shot admin action, NOT a resumable background scheduler with its own
 * persisted cursor (unlike `FinanceReceiptIngestScheduler`). A caller
 * backfilling the full 163-month history should call this in reasonably
 * sized chunks (e.g. a few years at a time) rather than one 163-month
 * request — `MAX_MONTHS_PER_RUN` caps a single call defensively, it does
 * NOT paginate automatically. A fully automatic, resumable version (its own
 * `SyncState` entity, walking backward like the receipt backfill lane) is
 * accepted follow-up debt — see this change's closing report for why it
 * wasn't built in this rework (a third resumable scheduler is a real design
 * decision, not something to bolt on unreviewed).
 */
export class BackfillFinanceMonthlySnapshots {
  constructor(
    private readonly buildMonthly: BuildFinanceMonthlySnapshot,
    private readonly buildCohort: BuildFinanceCohortSnapshot,
    /**
     * fix-wave-3 (🔵 5) — injectable clock, defaults to the real system
     * clock. Exists ONLY so tests can pin "now" without depending on the
     * machine's real date; production call sites never pass this.
     */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(fromYearMonth: string, toYearMonth: string): Promise<BackfillFinanceMonthlySnapshotsResult> {
    if (!isValidYearMonth(fromYearMonth)) throw new Error(`BackfillFinanceMonthlySnapshots: "${fromYearMonth}" no es un YYYY-MM válido`);
    if (!isValidYearMonth(toYearMonth)) throw new Error(`BackfillFinanceMonthlySnapshots: "${toYearMonth}" no es un YYYY-MM válido`);
    if (compareYearMonth(fromYearMonth, toYearMonth) > 0) {
      throw new Error(`BackfillFinanceMonthlySnapshots: from (${fromYearMonth}) debe ser <= to (${toYearMonth})`);
    }
    // fix-wave-3 (🔵 5) — "to" cannot be beyond the current calendar month
    // (AR time, same convention as the rest of finance-growth). Without this,
    // a fat-fingered `to: 2030-12` would compute and PERSIST dozens of
    // all-zero snapshots for months that haven't happened yet — a cliff-drop
    // to zero the overview would read as a real collapse.
    const currentYearMonth = arYearMonth(this.now());
    if (compareYearMonth(toYearMonth, currentYearMonth) > 0) {
      throw new Error(
        `BackfillFinanceMonthlySnapshots: "to" (${toYearMonth}) no puede ser un mes futuro (mes actual: ${currentYearMonth}) — evita congelar snapshots vacíos para meses que todavía no ocurrieron.`,
      );
    }

    const months: string[] = [];
    let cursor = fromYearMonth;
    while (compareYearMonth(cursor, toYearMonth) <= 0) {
      months.push(cursor);
      if (months.length > MAX_MONTHS_PER_RUN) {
        throw new Error(`BackfillFinanceMonthlySnapshots: rango de ${fromYearMonth} a ${toYearMonth} excede el máximo de ${MAX_MONTHS_PER_RUN} meses por corrida — pedí un rango más chico.`);
      }
      cursor = addMonthsToYearMonth(cursor, 1);
    }

    const monthsComputed: string[] = [];
    const monthsFailed: Array<{ yearMonth: string; error: string }> = [];
    for (const ym of months) {
      try {
        await this.buildMonthly.execute(ym);
        await this.buildCohort.execute(ym);
        monthsComputed.push(ym);
      } catch (err) {
        monthsFailed.push({ yearMonth: ym, error: (err as Error).message });
      }
    }

    return { monthsComputed, monthsFailed };
  }
}
