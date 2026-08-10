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
export function financeAnnulmentGuard(
  mapped: MappedGrReceipt[],
  cfg: Pick<FinanceReceiptSyncConfig, 'annulmentGuardMaxPct' | 'annulmentGuardMinCount'>,
  lane: string,
): void {
  const total = mapped.length;
  if (total === 0) return;

  const annulled = mapped.filter((m) => m.receipt.anulado).length;
  const fires = annulled >= cfg.annulmentGuardMinCount && annulled * 100 > cfg.annulmentGuardMaxPct * total;
  if (!fires) return;

  const pct = Math.round((annulled / total) * 100);
  // Design.md Decision 4 — up to 5 raw fecha_anulacion samples, the
  // 10-second diagnostic: identical values -> centinela drift; varied
  // real-looking dates -> a legitimate ratio spike, raise the knob.
  const sample = mapped
    .filter((m) => m.receipt.anulado)
    .slice(0, 5)
    .map((m) => m.receipt.grReceiptId)
    .join(', ');

  const message = `ABORT anulados=${annulled}/${total} (${pct}%) umbral=${cfg.annulmentGuardMaxPct}% min=${cfg.annulmentGuardMinCount} lane=${lane} muestra=[${sample}]`;
  console.error(`[finance-receipts-${lane}] ${message}`);
  throw new FinanceReceiptAnnulmentGuardError(message);
}
