import { addMonthsToYearMonth, previousYearMonth, compareYearMonth } from '@application/use-cases/finance/financeDates';

/**
 * finance-growth Fase 4 (design.md Decision 3) — pure chained-inflation-index
 * builder, extracted so `GetFinanceOverview` and its tests can exercise the
 * IPC math (task 4.1-4.3, the "corazón de la fase") in complete isolation
 * from the snapshot-reading plumbing.
 */
export interface ChainedIndexResult {
  /**
   * `chainedIndex(base) = 1`; every OTHER month present is reachable from
   * `base` without a gap in its direction. A month ABSENT from this map has
   * NO derivable real value for that month — the caller (`GetFinanceOverview`)
   * reads absence directly (`!chainedIndexByMonth.has(m)`) to build
   * `realSeriesMissingMonths`, never a single cutoff marker.
   *
   * fix-wave-4 🔴1 — this used to also return a single `truncatedAt: string |
   * null`, which could not describe more than one gap. Measured
   * counterexample: `base=2026-03`, rates loaded ONLY at 2026-03/2026-04,
   * requested `[2026-01, 2026-06]` → the reachable set was the
   * NON-CONTIGUOUS `{02, 03, 04}` (a real value each), with `01/05/06`
   * missing — `truncatedAt` reported a single month (`2026-01`, the backward
   * gap's reporting convention) and the caller could not derive the nulls
   * for 02/03/04 (which are NOT null) nor 05/06 (which ARE) from that one
   * string. See `financeInflation.test.ts` for the worked-through case.
   */
  chainedIndexByMonth: Map<string, number>;
}

/**
 * Builds the chained index from `base` outward far enough to cover
 * `[from, to]`, per design.md Decision 3:
 *
 *   chainedIndex(base) = 1
 *   chainedIndex(m)     = chainedIndex(m-1) × (1 + rate(m)/100)     — forward, m > base
 *   chainedIndex(m)     = chainedIndex(m+1) / (1 + rate(m+1)/100)   — backward, m < base
 *
 * FAIL-LOUD, never interpolates and never assumes 0%: the walk in EACH
 * direction stops dead at the first month whose `rate` is missing from
 * `ratesByMonth` — every month beyond that stop, in that direction, is simply
 * absent from `chainedIndexByMonth` (the caller reads that as `null` real
 * value, never a guessed number).
 *
 * Direction split:
 * - FORWARD gap (base at/before `from`, the case every spec.md scenario
 *   tests): `truncatedAt` is the exact missing month — the tested, expected
 *   shape ("un mes SIN IPC dentro del rango, la serie real se trunca ahí").
 * - BACKWARD gap (base strictly after `from`, an atypical but handled
 *   configuration): a missing rate blocks EVERY earlier month down through
 *   `from` in one shot, so `truncatedAt` reports `from` itself — the
 *   earliest month the caller actually asked for that can never be reached —
 *   rather than the technically-missing month, which can sit chronologically
 *   BEFORE `from` and would be a useless coordinate to hand back.
 * - If gaps exist in BOTH directions, the earlier (chronologically smaller)
 *   of the two candidates wins, so `truncatedAt` always names the first
 *   broken month a caller scanning the range left-to-right would hit.
 */
export function buildChainedIndex(base: string, from: string, to: string, ratesByMonth: Map<string, number>): ChainedIndexResult {
  const chainedIndexByMonth = new Map<string, number>();
  chainedIndexByMonth.set(base, 1);

  // Forward: base+1 .. to.
  if (compareYearMonth(to, base) > 0) {
    let curIndex = 1;
    let m = addMonthsToYearMonth(base, 1);
    while (compareYearMonth(m, to) <= 0) {
      const rate = ratesByMonth.get(m);
      if (rate === undefined) break;
      curIndex = curIndex * (1 + rate / 100);
      chainedIndexByMonth.set(m, curIndex);
      m = addMonthsToYearMonth(m, 1);
    }
  }

  // Backward: base-1 .. from.
  if (compareYearMonth(from, base) < 0) {
    let curIndex = 1;
    let cur = base;
    while (compareYearMonth(cur, from) > 0) {
      const rate = ratesByMonth.get(cur); // rate(cur) bridges cur → cur-1 (design.md's `m+1` when target is `m = cur-1`).
      if (rate === undefined) break;
      curIndex = curIndex / (1 + rate / 100);
      cur = previousYearMonth(cur);
      chainedIndexByMonth.set(cur, curIndex);
    }
  }

  return { chainedIndexByMonth };
}
