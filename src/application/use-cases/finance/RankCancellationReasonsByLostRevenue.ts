import type { ContractServiceEventRepository, ContractServiceEventWithClient } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ContractRepository } from '@domain/ports/ContractRepository';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { FinancePlanPriceRepository } from '@domain/ports/FinancePlanPriceRepository';
import { isValidYearMonth, compareYearMonth, yearMonthToDateRange, assertYearMonthRangeWidth } from '@application/use-cases/finance/financeDates';
import { resolvedPlanCodeAt } from '@application/use-cases/finance/contractLifecycle';
import { roundToScale } from '@application/use-cases/finance/financeDecimal';
import { FinanceValidationError } from '@domain/errors/finance';

const UNSPECIFIED_REASON = 'sin especificar';

export interface CancellationReasonRow {
  motivo: string;
  bajas: number;
  mrrPerdidoArs: number;
  /**
   * fix-wave-4 (🔴3) — count of `bajas` in THIS motivo whose contracted price
   * could not be resolved (no PppoeService plan, or a plan absent from
   * `FinancePlanPrice`) and therefore contribute `0` to `mrrPerdidoArs`
   * instead of their real lost revenue. Measured prod state: `FinancePlanPrice`
   * is EMPTY (387/387 contratos sin precio) — every row's `mrrPerdidoArs`
   * reads `$0`, the DESC sort collapses to insertion order, and the endpoint's
   * entire reason for existing (rank by MONEY, not count) silently disappears
   * with zero signal. This is the same honesty rule as `/overview`'s
   * `unpricedContractsActive`, applied per-motivo instead of per-month.
   */
  bajasSinPrecio: number;
}

export interface RankCancellationReasonsResult {
  motivos: CancellationReasonRow[];
}

/**
 * finance-growth Fase 4 — `GET /motivos-baja` (spec.md "Cancellation-reason
 * ranking is ordered by lost revenue, not count"). Fallback chain per
 * cancellation: `Contract.motivoBaja` → `ContractServiceEvent.reason` →
 * `"sin especificar"` — NEVER a dropped row. Sorted DESC by `mrrPerdidoArs`,
 * deliberately NOT by `bajas` — a low-volume, high-value reason must outrank
 * a high-volume, low-value one.
 *
 * `mrrPerdidoArs` per baja = the contract's contracted price (design.md
 * Decision 1b's MRR CONTRATADO, `PppoeService.profile` rewound via
 * `resolvedPlanCodeAt` to the exact churn instant) — a contract whose price
 * cannot be resolved contributes `0` here (never guessed), same honesty rule
 * as `BuildFinanceMonthlySnapshot`'s `unpricedContractsActive`.
 */
export class RankCancellationReasonsByLostRevenue {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractRepo: ContractRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly planPriceRepo: FinancePlanPriceRepository,
  ) {}

  async execute(from: string, to: string): Promise<RankCancellationReasonsResult> {
    if (!isValidYearMonth(from) || !isValidYearMonth(to)) {
      throw new FinanceValidationError('"from" y "to" deben tener formato "YYYY-MM"');
    }
    if (compareYearMonth(from, to) > 0) {
      throw new FinanceValidationError('"from" debe ser <= "to"');
    }
    assertYearMonthRangeWidth(from, to);

    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) {
      throw new Error('RankCancellationReasonsByLostRevenue: ServiceCatalog "INTERNET" no existe — catálogo mal seedeado');
    }

    const { start: rangeStart } = yearMonthToDateRange(from);
    const rangeEndInstant = new Date(yearMonthToDateRange(to).endExclusive.getTime() - 1);

    const bajaEvents = await this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'deactivated', from: rangeStart, to: rangeEndInstant });
    if (bajaEvents.length === 0) return { motivos: [] };

    const bajaContractIds = [...new Set(bajaEvents.map((e) => e.contractId))];
    const [contractDetails, fullHistory, currentProfileByContract, planPriceRows] = await Promise.all([
      this.contractRepo.findFinanceDetailsByIds(bajaContractIds),
      this.eventRepo.list({ serviceCatalogId: internet.id, contractIds: bajaContractIds }),
      this.pppoeRepo.findCurrentProfilesByContractIds(bajaContractIds),
      this.planPriceRepo.list(),
    ]);
    const planPricesByCode = new Map(planPriceRows.map((p) => [p.planCode, p.estimatedMonthlyPrice]));

    const eventsAsc = [...fullHistory].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const eventsByContract = new Map<string, ContractServiceEventWithClient[]>();
    for (const e of eventsAsc) {
      const list = eventsByContract.get(e.contractId);
      if (list) list.push(e);
      else eventsByContract.set(e.contractId, [e]);
    }

    // fix-wave-4 🟡10 — grouped by a TRIMMED + case-insensitive key so
    // "Contrato"/"  Contrato  " and "Precio"/"precio" (free-text GR fields,
    // never validated against a fixed vocabulary) land in ONE row instead of
    // silently splitting the same motivo's money across two. The bucket keeps
    // the FIRST-SEEN (trimmed) casing as the display value — grouping never
    // rewrites what the operator actually typed, it only stops treating
    // whitespace/casing as if they were different reasons.
    const byMotivo = new Map<string, { motivo: string; bajas: number; mrrPerdidoArs: number; bajasSinPrecio: number }>();
    for (const bajaEvent of bajaEvents) {
      const details = contractDetails.get(bajaEvent.contractId);
      // `.trim()` BEFORE the `||` fallback — a whitespace-only value like
      // `"   "` is a non-empty string (truthy under `||`) and would otherwise
      // pass through untouched instead of falling back to the next source.
      const rawMotivo = details?.motivoBaja?.trim() || bajaEvent.reason?.trim() || UNSPECIFIED_REASON;
      const normalizedKey = rawMotivo.toLowerCase();

      const planCode = resolvedPlanCodeAt(
        eventsByContract.get(bajaEvent.contractId) ?? [],
        new Date(bajaEvent.createdAt),
        currentProfileByContract.get(bajaEvent.contractId) ?? null,
      );
      // fix-wave-4 🔴3 — resolvable EXACTLY when a plan code exists AND that
      // code has a row in `FinancePlanPrice` (`.has`, not `?? 0` — a price of
      // a REAL 0 must never be mistaken for "unresolved").
      const priceResolved = planCode !== null && planPricesByCode.has(planCode);
      const price = priceResolved ? (planPricesByCode.get(planCode) as number) : 0;

      const bucket = byMotivo.get(normalizedKey) ?? { motivo: rawMotivo, bajas: 0, mrrPerdidoArs: 0, bajasSinPrecio: 0 };
      bucket.bajas += 1;
      bucket.mrrPerdidoArs = roundToScale(bucket.mrrPerdidoArs + price, 2);
      if (!priceResolved) bucket.bajasSinPrecio += 1;
      byMotivo.set(normalizedKey, bucket);
    }

    // fix-wave-4 🔵16 — deterministic tie-break: DESC by mrrPerdidoArs
    // (unchanged), then ASC by `motivo` so equal-value rows render in the
    // same order every request instead of depending on `Map` iteration order.
    const motivos = [...byMotivo.values()]
      .map((b) => ({ motivo: b.motivo, bajas: b.bajas, mrrPerdidoArs: b.mrrPerdidoArs, bajasSinPrecio: b.bajasSinPrecio }))
      .sort((a, b) => (b.mrrPerdidoArs !== a.mrrPerdidoArs ? b.mrrPerdidoArs - a.mrrPerdidoArs : a.motivo.localeCompare(b.motivo)));

    return { motivos };
  }
}
