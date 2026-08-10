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
 * before a lane gives that range up. RF4's rationale (an abort re-persisted the
 * cursor UNCHANGED, and a composite cursor makes a lane permanently "due", so
 * the same poisoned page was re-requested on every eligible tick forever) is
 * unchanged; the THRESHOLD and the counter that feeds it moved to
 * `financeGuardAbortStreak.ts` in fix-wave-2 RFX3, because the counter stopped
 * being a string parsed out of `lastResult` and became persisted state of its
 * own. See that module for why.
 */

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
