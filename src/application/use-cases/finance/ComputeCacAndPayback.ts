import type { FinanceTechnologyCostRepository } from '@domain/ports/FinanceTechnologyCostRepository';
import type { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import type { FinanceTargetsConfigRepository } from '@domain/ports/FinanceTargetsConfigRepository';
import type { ContractServiceEventRepository, ContractServiceEventWithClient } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ContractRepository, ContractFinanceDetails } from '@domain/ports/ContractRepository';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { FinancePlanPriceRepository } from '@domain/ports/FinancePlanPriceRepository';
import type { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import type { ClientMirrorReadRepository } from '@domain/ports/ClientMirrorReadRepository';
import { FinanceTechnologyNotFoundError, FinanceValidationError } from '@domain/errors/finance';
import { isValidYearMonth, yearMonthToDateRange } from '@application/use-cases/finance/financeDates';
import { resolvedPlanCodeAt, isContractActiveDuring } from '@application/use-cases/finance/contractLifecycle';
import { attributeCollectedAmountToContracts, type AttributedContractShare, type AttributionConfidence } from '@application/use-cases/finance/financeAttribution';
import { roundToScale } from '@application/use-cases/finance/financeDecimal';

export interface CacAltaRow {
  contractId: string;
  clientId: string;
  customerName: string | null;
  mrrAtribuidoArs: number;
  attributionConfidence: AttributionConfidence;
  /** `null` when `mrrAtribuidoArs` is 0 — NEVER divides by zero, NEVER `Infinity`. */
  paybackMonths: number | null;
  lossMaking: boolean;
}

export interface ComputeCacAndPaybackResult {
  technology: string;
  /**
   * fix (finance-growth Fase 4 — "no configurado" ≠ "cero" trap flagged by
   * the Fase 3 review): `false` when `FinanceTechnologyCost` has NO row for
   * this technology at all. `costoVentaArs`/`costoInstalacionArs`/`cacArs`
   * are `null` in that case — reading `cacArs: 0` as "every sale here is
   * profitable" is exactly the bug this field exists to prevent.
   */
  costConfigured: boolean;
  /**
   * fix-wave-4 (🟡7) — `true` when a `FinanceTechnologyCost` row EXISTS
   * (`costConfigured: true`) but `costoVentaArs + costoInstalacionArs === 0`
   * — both cost columns default to `@default(0)` in the schema, so a row
   * created (e.g. via the settables UI) and never actually filled in is
   * INDISTINGUISHABLE from a genuinely free technology under `costConfigured`
   * alone. Always `false` when `costConfigured` is `false` (that case is
   * already covered honestly by `cacArs: null`).
   */
  costIsZero: boolean;
  costoVentaArs: number | null;
  costoInstalacionArs: number | null;
  cacArs: number | null;
  altasDelMes: CacAltaRow[];
  /**
   * fix-wave-4 (🔴2) — count of this month's altas (deduped by contract,
   * same activated+reactivated criterion as `altasDelMes`) whose
   * `Contract.technology` is `null` — UNRESOLVABLE, not "belongs to a
   * different technology". `Contract.technology` is `null` for MOST
   * GR-derived contracts (see `ContractRepository.findFinanceDetailsByIds`'s
   * docblock) — before this field existed, those altas simply vanished from
   * EVERY technology's `altasDelMes`, so a real month with real sales and
   * real collected cash could render as `altasDelMes: []` with a perfectly
   * healthy `cacArs` — "CAC $30.000, cero ventas" instead of the truth,
   * "N ventas que no puedo clasificar". Same honesty rule as `/overview`'s
   * `unpricedContractsActive`: never a silent zero.
   */
  altasDelMesSinTecnologia: number;
  maxPaybackMonths: number;
}

/**
 * finance-growth Fase 4 — `GET /cac`. `mrrAtribuidoArs` per alta reuses the
 * EXACT Capa B cash-attribution logic (`attributeCollectedAmountToContracts`,
 * design.md Decision 1) — a new sale's payback is judged against real
 * collected cash, not the theoretical contracted price, so
 * `attributionConfidence` travels through unchanged.
 */
export class ComputeCacAndPayback {
  constructor(
    private readonly technologyCostRepo: FinanceTechnologyCostRepository,
    private readonly technologyCatalogRepo: ContractTechnologyRepository,
    private readonly targetsRepo: FinanceTargetsConfigRepository,
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractRepo: ContractRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly planPriceRepo: FinancePlanPriceRepository,
    private readonly itemRepo: FinanceReceiptItemRepository,
    private readonly clientLinks: ClientMirrorReadRepository,
  ) {}

  async execute(technology: string, yearMonth: string): Promise<ComputeCacAndPaybackResult> {
    if (!isValidYearMonth(yearMonth)) {
      throw new FinanceValidationError('"yearMonth" debe tener formato "YYYY-MM"');
    }

    const tech = await this.technologyCatalogRepo.getByName(technology);
    if (!tech) throw new FinanceTechnologyNotFoundError(technology);
    const canonicalName = tech.name;

    const [costRow, targets, internet] = await Promise.all([
      this.technologyCostRepo.getByTechnology(canonicalName),
      this.targetsRepo.get(),
      this.catalogRepo.getByName('INTERNET'),
    ]);
    if (!internet) {
      throw new Error('ComputeCacAndPayback: ServiceCatalog "INTERNET" no existe — catálogo mal seedeado');
    }

    const costConfigured = costRow !== null;
    const costoVentaArs = costRow ? costRow.costoVentaArs : null;
    const costoInstalacionArs = costRow ? costRow.costoInstalacionArs : null;
    const cacArs = costRow ? roundToScale(costRow.costoVentaArs + costRow.costoInstalacionArs, 2) : null;
    const costIsZero = costConfigured && cacArs === 0;

    const { start: monthStart, endExclusive: monthEndExclusive } = yearMonthToDateRange(yearMonth);
    const monthEndInstant = new Date(monthEndExclusive.getTime() - 1);

    const [activated, reactivated] = await Promise.all([
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'activated', from: monthStart, to: monthEndInstant }),
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'reactivated', from: monthStart, to: monthEndInstant }),
    ]);
    const altaEvents = [...activated, ...reactivated];

    const altaContractIds = [...new Set(altaEvents.map((e) => e.contractId))];
    const contractDetails: Map<string, ContractFinanceDetails> =
      altaContractIds.length > 0 ? await this.contractRepo.findFinanceDetailsByIds(altaContractIds) : new Map();

    // Dedup by contractId (a contract could carry BOTH an 'activated' and a
    // 'reactivated' event in the same month in a rare edge case) — one row
    // per sale in the CAC listing, matching contract, not events.
    //
    // fix-wave-4 🟡6 — case-INSENSITIVE technology match. `ContractTechnology
    // Repository.getByName` (which resolved `canonicalName` above) is already
    // case-insensitive; comparing `Contract.technology` against `canonicalName`
    // with a strict `!==` silently dropped an alta whose free-text column read
    // `"fibra"` against a catalog canonical of `"Fibra"` — same technology,
    // different case, zero signal that it happened.
    const canonicalNameLower = canonicalName.toLowerCase();
    const seen = new Set<string>();
    const qualifyingAltas: ContractServiceEventWithClient[] = [];
    let altasDelMesSinTecnologia = 0;
    const seenForCount = new Set<string>();
    for (const e of altaEvents) {
      const technology = contractDetails.get(e.contractId)?.technology ?? null;
      const matchesTechnology = technology !== null && technology.toLowerCase() === canonicalNameLower;
      if (!matchesTechnology && technology === null && !seenForCount.has(e.contractId)) {
        // fix-wave-4 🔴2 — counted ONCE per contract, same dedup criterion as
        // `altasDelMes`, but counted regardless of `seen` below (a null-tech
        // alta never enters `seen` since it never qualifies).
        seenForCount.add(e.contractId);
        altasDelMesSinTecnologia += 1;
      }
      if (seen.has(e.contractId)) continue;
      if (!matchesTechnology) continue;
      seen.add(e.contractId);
      qualifyingAltas.push(e);
    }

    if (qualifyingAltas.length === 0) {
      return {
        technology: canonicalName,
        costConfigured,
        costIsZero,
        costoVentaArs,
        costoInstalacionArs,
        cacArs,
        altasDelMes: [],
        altasDelMesSinTecnologia,
        maxPaybackMonths: targets.maxPaybackMonths,
      };
    }

    // Group by clientId — attribution (Decision 1) splits a client's
    // collected cash across ALL their internet contracts active during the
    // month, never just the new one.
    const clientIdOf = (e: ContractServiceEventWithClient): string | null => contractDetails.get(e.contractId)?.clientId ?? e.clientId ?? null;
    const clientIds = [...new Set(qualifyingAltas.map(clientIdOf).filter((id): id is string => id !== null))];

    const [grIdByClientId, planPriceRows] = await Promise.all([this.clientLinks.getGrClienteIdsByClientIds(clientIds), this.planPriceRepo.list()]);
    const planPricesByCode = new Map(planPriceRows.map((p) => [p.planCode, p.estimatedMonthlyPrice]));

    const shareByContract = new Map<string, AttributedContractShare>();
    for (const clientId of clientIds) {
      const clientEvents = await this.eventRepo.list({ serviceCatalogId: internet.id, clientId });
      const eventsAsc = [...clientEvents].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      const eventsByContract = new Map<string, ContractServiceEventWithClient[]>();
      for (const e of eventsAsc) {
        const list = eventsByContract.get(e.contractId);
        if (list) list.push(e);
        else eventsByContract.set(e.contractId, [e]);
      }
      const clientContractIds = [...eventsByContract.keys()];
      const activeContractIds = clientContractIds.filter((cid) => isContractActiveDuring(eventsByContract.get(cid) ?? [], monthStart, monthEndExclusive));
      const currentProfileByContract = await this.pppoeRepo.findCurrentProfilesByContractIds(activeContractIds);
      const attributable = activeContractIds.map((cid) => ({
        contractId: cid,
        planCode: resolvedPlanCodeAt(eventsByContract.get(cid) ?? [], monthEndInstant, currentProfileByContract.get(cid) ?? null),
      }));

      const grClienteId = grIdByClientId.get(clientId);
      let shares: AttributedContractShare[];
      if (grClienteId) {
        const items = await this.itemRepo.listByClientAndMonth(grClienteId, yearMonth);
        const collectedAmountArs = roundToScale(
          items.reduce((sum, i) => sum + i.amount, 0),
          2,
        );
        shares = attributeCollectedAmountToContracts(collectedAmountArs, attributable, planPricesByCode);
      } else {
        // No resolvable GR client link at all — nothing to attribute
        // (`BuildFinanceMonthlySnapshot`'s orphan-client fallback, same
        // criterion): 0, never a guess, always visible via `estimated-equal`.
        shares = attributable.map((a) => ({ contractId: a.contractId, amountArs: 0, attributionConfidence: 'estimated-equal' as const }));
      }
      for (const s of shares) shareByContract.set(s.contractId, s);
    }

    const altasDelMes: CacAltaRow[] = qualifyingAltas.map((e) => {
      const details = contractDetails.get(e.contractId);
      const share = shareByContract.get(e.contractId);
      const mrrAtribuidoArs = share?.amountArs ?? 0;
      const attributionConfidence: AttributionConfidence = share?.attributionConfidence ?? 'estimated-equal';
      const paybackMonths = cacArs !== null && mrrAtribuidoArs > 0 ? roundToScale(cacArs / mrrAtribuidoArs, 2) : null;
      const lossMaking = paybackMonths !== null && paybackMonths > targets.maxPaybackMonths;
      return {
        contractId: e.contractId,
        clientId: details?.clientId ?? e.clientId ?? '',
        customerName: details?.customerName ?? e.customerName ?? null,
        mrrAtribuidoArs,
        attributionConfidence,
        paybackMonths,
        lossMaking,
      };
    });

    return {
      technology: canonicalName,
      costConfigured,
      costIsZero,
      costoVentaArs,
      costoInstalacionArs,
      cacArs,
      altasDelMes,
      altasDelMesSinTecnologia,
      maxPaybackMonths: targets.maxPaybackMonths,
    };
  }
}
