import { MappedGrReceipt } from './mapGrReceipt';
import { FinanceReceiptSyncConfig } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { FinanceReceiptAnnulmentGuardError } from './financeIngestErrors';

/**
 * gr-receipt-annulment (design.md Decision 4) — systemic guard: aborts a page
 * BEFORE any write when the annulled ratio spikes. Protects against a GR
 * sentinel-format drift flooding the mirror with false `anulado: true` (see
 * `isRealAnnulment`'s per-row fail-closed residue) — a page's worth of drift
 * gets caught HERE instead of silently voiding the whole mirror.
 *
 * Pure, no I/O — called in the use case between `receipts.map(mapGrReceipt)`
 * and the first `upsertBatch`. "One `execute()` = one page" is the existing
 * invariant of this module (delta/backfill already work this way); the ratio
 * is computed over THAT page, never a cross-tick accumulator (by the time a
 * multi-page sweep closed, the damage would already be written).
 *
 * `total > 0` guards the division; `annulled >= annulmentGuardMinCount` is
 * the ABSOLUTE floor — without it a 3-receipt tail page with 1 real
 * annulment (33%) would abort forever on the exact case (rare, legitimate
 * annulment) the guard must NOT catch. The percent comparison is strictly
 * `>` (5/100 passes, 6/100 aborts), integer arithmetic
 * (`annulled * 100 > cfg.annulmentGuardMaxPct * total`) so no floating-point
 * rounding can flip the frontier.
 */
/**
 * fix-wave RF4 — how many CONSECUTIVE systemic-guard aborts on the same range
 * before a lane gives that range up.
 *
 * Before this, an abort re-persisted the cursor UNCHANGED, and a composite
 * (pending-pages) cursor makes a lane permanently "due": the same poisoned page
 * was re-requested on every eligible tick, forever, with no backoff and no way
 * out short of an operator editing `SyncState` by hand. Three retries rides out
 * a transient GR hiccup; past that the page is not going to fix itself in the
 * next 20 seconds, and the healthy thing is to stop hammering and come back on
 * the normal cadence.
 *
 * Lives HERE, next to the guard itself, because BOTH the delta and reconcile
 * lanes need the identical bookkeeping — a second copy would be exactly the
 * "the function that decides is not the one under test" trap. The backfill lane
 * deliberately does NOT use it: there, abandoning a range means permanently
 * skipping a month of history, while delta and reconcile both re-scan
 * overlapping ranges by design, so giving one up costs only a delay.
 */
export const GUARD_ABORT_ABANDON_THRESHOLD = 3;

/** Marker written into `SyncState.lastResult` to carry the streak across ticks (there is no dedicated field). */
export const GUARD_ABORT_MARKER = 'guardAborts=';

/**
 * Reads the streak back out of `lastResult`. Any result WITHOUT the marker —
 * a success (`page ok`, `sweep ok`), a non-guard error, or the message written
 * when a range is abandoned — parses as 0, which is what makes the streak
 * self-resetting: the counter only survives across consecutive guard aborts.
 */
export function parseGuardAbortStreak(lastResult: string | null | undefined): number {
  if (!lastResult) return 0;
  const match = lastResult.match(/guardAborts=(\d+)/);
  return match ? Number(match[1]) : 0;
}

export interface AnnulmentGuardPageContext {
  /** The GR date range this page was requested with, e.g. `"06-07-2026..09-08-2026"`. */
  rango: string;
  /** The page's offset within that range — with `rango`, this identifies the exact GR call to re-run by hand. */
  offset: number;
}

export function financeAnnulmentGuard(
  mapped: MappedGrReceipt[],
  cfg: Pick<FinanceReceiptSyncConfig, 'annulmentGuardMaxPct' | 'annulmentGuardMinCount'>,
  lane: string,
  ctx: AnnulmentGuardPageContext,
): void {
  const total = mapped.length;
  if (total === 0) return;

  const annulled = mapped.filter((m) => m.receipt.anulado).length;
  const fires = annulled >= cfg.annulmentGuardMinCount && annulled * 100 > cfg.annulmentGuardMaxPct * total;
  if (!fires) return;

  const pct = Math.round((annulled / total) * 100);
  // Design.md Decision 4 — up to 5 RAW `fecha_anulacion` samples, the
  // 10-second diagnostic: identical values -> centinela drift (the mirror is
  // about to be falsely voided, do NOT raise the knob); varied real-looking
  // dates -> a legitimate ratio spike, raise the knob. fix-wave RF5: this
  // used to print `grReceiptId`s — ids that answer neither question — and no
  // test read the message at all, so the diagnostic design.md specified was
  // simply absent. `rango`/`offset` complete it: they name the exact GR page
  // to re-request by hand.
  const sample = mapped
    .filter((m) => m.receipt.anulado)
    .slice(0, 5)
    .map((m) => `${m.receipt.grReceiptId}="${m.rawFechaAnulacion === null ? 'null' : m.rawFechaAnulacion}"`)
    .join(', ');

  const message = `ABORT anulados=${annulled}/${total} (${pct}%) umbral=${cfg.annulmentGuardMaxPct}% min=${cfg.annulmentGuardMinCount} lane=${lane} rango=${ctx.rango} offset=${ctx.offset} muestra=[${sample}]`;
  console.error(`[finance-receipts-${lane}] ${message}`);
  throw new FinanceReceiptAnnulmentGuardError(message);
}
