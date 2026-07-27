import type { FinanceInvoiceTypeBucket } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';

/**
 * finance-growth Fase 3 (design.md Decision 1 — "dos capas, nunca una sola
 * verdad") — pure helpers for the two seams the whole metrics engine hangs
 * off of: attributing a client's collected cash to its individual contracts
 * (Capa B), and netting a set of comprobante-typed amounts by bucket
 * (revenue/contra/excluded/unclassified, Decision 2).
 *
 * ⚠️ DEVIATION from tasks.md's literal signature
 * `attributeCollectedAmountToContracts(applications, contracts, planPrices)`:
 * this takes a pre-computed `collectedAmountArs: number`, NOT a raw
 * `FinanceReceiptApplication[]`. This is deliberate, not an oversight —
 * Decision 0c (fix-wave-2 R1, LOCK del usuario) moved the "cash collected"
 * source from `FinanceReceiptApplication` (aplicaciones = deuda cancelada) to
 * `FinanceReceiptItem` (items = cash real), specifically to stop
 * over-counting by the total of `retenciones`. `FinanceReceiptItem` carries
 * NO `grType` (it's a payment-method row — banco/transferencia/efectivo —
 * not a comprobante type), so it cannot be netted by bucket the way
 * `FinanceReceiptApplication` can. Keeping this function agnostic to WHERE
 * the number came from (its caller, `BuildFinanceMonthlySnapshot`, sums
 * `FinanceReceiptItem` for the client+month and passes the total in) means
 * the same distribution logic serves the cash-based Capa B attribution
 * *and* is reusable by `ComputeCacAndPayback` (Fase 4) without either one
 * needing to reconstruct a fake "applications" array just to satisfy this
 * signature.
 */

export type AttributionConfidence = 'exact' | 'estimated' | 'estimated-equal';

export interface AttributableContract {
  contractId: string;
  /**
   * The contract's current plan code (matches `FinancePlanPrice.planCode` /
   * `Plan.code`), or `null` when it cannot be resolved (e.g. a contract that
   * never had a `modified` plan-change event — see
   * `BuildFinanceMonthlySnapshot`'s docblock on why we never fall back to
   * `Contract.plan`, a different, GR-owned vocabulary). A `null`/unpriced
   * code is treated as proportional weight `0` (spec.md 3.7's recommended
   * criterion), never as a crash or an implicit equal share.
   */
  planCode: string | null;
}

export interface AttributedContractShare {
  contractId: string;
  amountArs: number;
  attributionConfidence: AttributionConfidence;
}

/** Rounds to the cent — money never carries more than 2 decimals past this boundary. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Splits `collectedAmountArs` (a client's net cash collected for one month)
 * across `contracts` (that client's contracts active during that month),
 * per design.md Decision 1:
 *
 * - 1 contract  → the whole amount, `exact`.
 * - N contracts, some priced → proportional to `estimatedMonthlyPrice`,
 *   `estimated`. An unpriced plan contributes weight 0 (spec.md 3.7).
 * - N contracts, none priced → equal split, `estimated-equal`.
 *
 * The split ALWAYS reconciles exactly to `collectedAmountArs` (to the cent):
 * every share except the last is rounded independently, and the last
 * absorbs whatever rounding remainder is left — the same "remainder to the
 * last bucket" idiom used elsewhere in the repo for centavo-safe splits.
 */
export function attributeCollectedAmountToContracts(
  collectedAmountArs: number,
  contracts: AttributableContract[],
  planPricesByCode: Map<string, number>,
): AttributedContractShare[] {
  if (contracts.length === 0) return [];

  if (contracts.length === 1) {
    return [{ contractId: contracts[0].contractId, amountArs: round2(collectedAmountArs), attributionConfidence: 'exact' }];
  }

  const weights = contracts.map((c) => (c.planCode ? planPricesByCode.get(c.planCode) ?? 0 : 0));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const confidence: AttributionConfidence = totalWeight > 0 ? 'estimated' : 'estimated-equal';
  const rawShares =
    totalWeight > 0
      ? weights.map((w) => (collectedAmountArs * w) / totalWeight)
      : contracts.map(() => collectedAmountArs / contracts.length);

  return distributeExact(collectedAmountArs, rawShares).map((amountArs, i) => ({
    contractId: contracts[i].contractId,
    amountArs,
    attributionConfidence: confidence,
  }));
}

/**
 * Rounds every value in `rawShares` to the cent except the last, which
 * absorbs `total - sum(others)` (also rounded) — guarantees
 * `sum(result) === round2(total)` even when naive per-share rounding would
 * drift by a centavo either way.
 */
function distributeExact(total: number, rawShares: number[]): number[] {
  if (rawShares.length === 0) return [];
  const rounded = rawShares.slice(0, -1).map(round2);
  const sumSoFar = rounded.reduce((a, b) => a + b, 0);
  const last = round2(total - sumSoFar);
  return [...rounded, last];
}

export interface NetCollectedResult {
  /** revenue minus contra, excluding `excluded` and `unclassified` entirely. */
  netAmount: number;
  /** Sum of amounts whose `grType` classifies (or defaults) to `unclassified` — never silently dropped. */
  unclassifiedAmount: number;
}

/**
 * finance-growth Fase 3 (design.md Decision 2) — nets a set of
 * comprobante-typed amounts (`FinanceReceiptApplication`-shaped: `{amount,
 * grType}`) by bucket: `revenue` sums, `contra` subtracts, `excluded` is
 * ignored entirely, `unclassified` (explicit bucket OR a `grType` absent
 * from `classifications`, e.g. not yet auto-classified by the ingest) is
 * excluded from `netAmount` but tallied into `unclassifiedAmount` — visible,
 * never a silently-dropped number (spec.md "An unseen grType is
 * auto-classified as unclassified, not dropped").
 *
 * Used by `BuildFinanceMonthlySnapshot` ONLY to compute the diagnostic
 * `unclassifiedAmountArs` field (an accounting-truth/Capa-A reconciliation
 * signal over `FinanceReceiptApplication`) — NEVER to compute
 * `revenueTotalArs`/`revenueAttributableArs`, which are cash-based
 * (`FinanceReceiptItem`, Decision 0c) and carry no `grType` to net by.
 */
export function netCollectedAmountForMonth(
  applications: Array<{ amount: number; grType: string }>,
  classifications: Map<string, FinanceInvoiceTypeBucket>,
): NetCollectedResult {
  let net = 0;
  let unclassified = 0;
  for (const a of applications) {
    const bucket = classifications.get(a.grType) ?? 'unclassified';
    if (bucket === 'revenue') net += a.amount;
    else if (bucket === 'contra') net -= a.amount;
    else if (bucket === 'excluded') continue;
    else unclassified += a.amount;
  }
  return { netAmount: round2(net), unclassifiedAmount: round2(unclassified) };
}
