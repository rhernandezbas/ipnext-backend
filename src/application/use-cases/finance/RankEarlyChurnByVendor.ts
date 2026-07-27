import type { ContractServiceEventRepository, ContractServiceEventWithClient } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ContractRepository } from '@domain/ports/ContractRepository';
import type { FinanceTargetsConfigRepository } from '@domain/ports/FinanceTargetsConfigRepository';
import { isValidYearMonth, compareYearMonth, yearMonthToDateRange, addCalendarMonthsToDate, assertYearMonthRangeWidth } from '@application/use-cases/finance/financeDates';
import { roundToScale } from '@application/use-cases/finance/financeDecimal';
import { FinanceValidationError } from '@domain/errors/finance';

export interface VendorEarlyChurnRow {
  vendedor: string;
  altasTotal: number;
  altasChurneadasTemprano: number;
  /**
   * fix-wave-4 (🟡5) — DENOMINATOR of `earlyChurnPct`, NOT `altasTotal`. An
   * alta counts as "matured" once its own "temprano" window has closed
   * (`now >= cutoffInstant`), OR immediately if it already churned early (a
   * churn event is a sealed verdict regardless of whether the window's full
   * duration has technically elapsed yet). An immature alta that has NOT
   * churned yet carries no verdict at all — including it in the denominator
   * as an implicit "did not churn" diluted the rate and buried vendors whose
   * newest altas simply haven't had time to fail (measured: 10 mature altas
   * at 50% real churn + 10 altas from last week reported 25% under the old
   * `altasTotal`-denominator code).
   */
  altasMaduras: number;
  /** `null` when `altasMaduras` is 0 — no matured alta exists yet to judge, NEVER a guessed 0%. */
  earlyChurnPct: number | null;
}

export interface RankEarlyChurnByVendorResult {
  windowMonths: number;
  vendors: VendorEarlyChurnRow[];
}

/**
 * finance-growth Fase 4 — `GET /vendors/early-churn` (spec.md "Early-churn-by-vendor
 * ranking exposes short-lived sales, not just volume"). The ranking's entire
 * point is ordering by `earlyChurnPct`, NOT `altasTotal` — a vendor with huge
 * volume but a contract base that cancels within the "temprano" window
 * (commission + install already paid) must NOT hide behind raw sale count.
 *
 * "Temprano" = `FinanceTargetsConfig.maxPaybackMonths` calendar months after
 * the alta (same proxy design.md/spec.md choose, "salvo que el usuario defina
 * otro corte" — no separate config exists for this yet).
 */
export class RankEarlyChurnByVendor {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractRepo: ContractRepository,
    private readonly targetsRepo: FinanceTargetsConfigRepository,
    /** fix-wave-4 🟡5 — injectable "now" for maturity judgement (`altasMaduras`); defaults to the real clock, overridable in tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(from: string, to: string): Promise<RankEarlyChurnByVendorResult> {
    if (!isValidYearMonth(from) || !isValidYearMonth(to)) {
      throw new FinanceValidationError('"from" y "to" deben tener formato "YYYY-MM"');
    }
    if (compareYearMonth(from, to) > 0) {
      throw new FinanceValidationError('"from" debe ser <= "to"');
    }
    assertYearMonthRangeWidth(from, to);

    const [internet, targets] = await Promise.all([this.catalogRepo.getByName('INTERNET'), this.targetsRepo.get()]);
    if (!internet) {
      throw new Error('RankEarlyChurnByVendor: ServiceCatalog "INTERNET" no existe — catálogo mal seedeado');
    }
    const windowMonths = targets.maxPaybackMonths;

    const { start: rangeStart } = yearMonthToDateRange(from);
    const rangeEndInstant = new Date(yearMonthToDateRange(to).endExclusive.getTime() - 1);

    const [activated, reactivated] = await Promise.all([
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'activated', from: rangeStart, to: rangeEndInstant }),
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'reactivated', from: rangeStart, to: rangeEndInstant }),
    ]);
    // fix-wave-4 🟡8 — dedup by contractId, same criterion as
    // `ComputeCacAndPayback` (a contract can legitimately carry BOTH an
    // 'activated' and a 'reactivated' event in the same range) — one alta per
    // CONTRACT, never one per event. Sorted ascending first so the row kept
    // is the EARLIEST of the two — the true start of the "temprano" window.
    const altaEventsSorted = [...activated, ...reactivated].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const seenContracts = new Set<string>();
    const altaEvents: ContractServiceEventWithClient[] = [];
    for (const e of altaEventsSorted) {
      if (seenContracts.has(e.contractId)) continue;
      seenContracts.add(e.contractId);
      altaEvents.push(e);
    }
    if (altaEvents.length === 0) return { windowMonths, vendors: [] };

    const altaContractIds = [...new Set(altaEvents.map((e) => e.contractId))];
    const [contractDetails, deactivations] = await Promise.all([
      this.contractRepo.findFinanceDetailsByIds(altaContractIds),
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'deactivated', contractIds: altaContractIds }),
    ]);

    const deactivationsByContract = new Map<string, ContractServiceEventWithClient[]>();
    for (const e of deactivations) {
      const list = deactivationsByContract.get(e.contractId);
      if (list) list.push(e);
      else deactivationsByContract.set(e.contractId, [e]);
    }

    const nowInstant = this.now();
    const byVendor = new Map<string, { altasTotal: number; maduras: number; churned: number }>();
    for (const alta of altaEvents) {
      // fix-wave-4 🟡11 — `.trim()` before the `||` fallback: a whitespace-only
      // vendedor (`"   "`) is a non-empty, TRUTHY string under `||` alone and
      // would otherwise open its own bucket instead of grouping under "sin
      // vendedor" like a genuinely empty/null value does.
      const vendedor = contractDetails.get(alta.contractId)?.vendedor?.trim() || 'sin vendedor';
      const bucket = byVendor.get(vendedor) ?? { altasTotal: 0, maduras: 0, churned: 0 };
      bucket.altasTotal += 1;

      // fix-wave-4 🔴4 — measured from the REAL alta INSTANT (design.md's own
      // wording: "calendar months AFTER THE ALTA"), never floored to the 1st
      // of its calendar month first. The old floor-then-add systematically
      // shrank the window by up to 30 days depending purely on the alta's day
      // of month — hitting hardest on end-of-month altas.
      const altaDate = new Date(alta.createdAt);
      const cutoffInstant = addCalendarMonthsToDate(altaDate, windowMonths);
      const churnedEarly = (deactivationsByContract.get(alta.contractId) ?? []).some((e) => {
        const d = new Date(e.createdAt);
        return d >= altaDate && d < cutoffInstant;
      });
      if (churnedEarly) bucket.churned += 1;

      // fix-wave-4 🟡5 — "matured" = the window has closed as of `now`, OR the
      // verdict is ALREADY sealed because it churned early (a churn event is
      // definitive regardless of whether the full window has technically
      // elapsed). An immature alta that has NOT churned yet carries no
      // verdict — it is neither a "success" nor a "failure" yet, so it must
      // not silently count as "did not churn" in the denominator.
      if (churnedEarly || nowInstant >= cutoffInstant) bucket.maduras += 1;

      byVendor.set(vendedor, bucket);
    }

    // fix-wave-4 🔵16 — deterministic tie-break: DESC by earlyChurnPct
    // (nulls — no matured altas yet — sort LAST, never mixed in arbitrarily),
    // then ASC by vendedor name so equal-rate vendors always render in the
    // same order across requests/pages instead of depending on Map iteration.
    const vendors = [...byVendor.entries()]
      .map(([vendedor, b]) => ({
        vendedor,
        altasTotal: b.altasTotal,
        altasChurneadasTemprano: b.churned,
        altasMaduras: b.maduras,
        earlyChurnPct: b.maduras > 0 ? roundToScale((b.churned / b.maduras) * 100, 2) : null,
      }))
      .sort((a, b) => {
        if (a.earlyChurnPct === null && b.earlyChurnPct === null) return a.vendedor.localeCompare(b.vendedor);
        if (a.earlyChurnPct === null) return 1;
        if (b.earlyChurnPct === null) return -1;
        if (b.earlyChurnPct !== a.earlyChurnPct) return b.earlyChurnPct - a.earlyChurnPct;
        return a.vendedor.localeCompare(b.vendedor);
      });

    return { windowMonths, vendors };
  }
}
