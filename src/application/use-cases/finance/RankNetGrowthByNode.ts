import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ContractRepository } from '@domain/ports/ContractRepository';
import { isValidYearMonth, compareYearMonth, yearMonthToDateRange, assertYearMonthRangeWidth } from '@application/use-cases/finance/financeDates';
import { FinanceValidationError } from '@domain/errors/finance';

export interface NodeGrowthRow {
  /** `null` = contracts with no node/AP assignment, grouped together — NEVER dropped from the ranking. */
  networkSiteId: string | null;
  networkSiteName: string | null;
  altas: number;
  bajas: number;
  netGrowth: number;
}

export interface RankNetGrowthByNodeResult {
  nodes: NodeGrowthRow[];
}

/**
 * finance-growth Fase 4 — `GET /nodes/growth`. Live query over
 * `ContractServiceEvent` (design.md Decision 4: rankings are queries vivas,
 * never precomputed), scoped to the INTERNET catalog like the rest of the
 * engine. Surfaces TECHNICAL churn (a node bleeding connections) independent
 * of the commercial cancellation-reason ranking.
 */
export class RankNetGrowthByNode {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractRepo: ContractRepository,
  ) {}

  async execute(from: string, to: string): Promise<RankNetGrowthByNodeResult> {
    if (!isValidYearMonth(from) || !isValidYearMonth(to)) {
      throw new FinanceValidationError('"from" y "to" deben tener formato "YYYY-MM"');
    }
    if (compareYearMonth(from, to) > 0) {
      throw new FinanceValidationError('"from" debe ser <= "to"');
    }
    assertYearMonthRangeWidth(from, to);

    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) {
      throw new Error('RankNetGrowthByNode: ServiceCatalog "INTERNET" no existe — catálogo mal seedeado');
    }

    const { start: rangeStart } = yearMonthToDateRange(from);
    const rangeEndInstant = new Date(yearMonthToDateRange(to).endExclusive.getTime() - 1);

    const [activated, reactivated, deactivated] = await Promise.all([
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'activated', from: rangeStart, to: rangeEndInstant }),
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'reactivated', from: rangeStart, to: rangeEndInstant }),
      this.eventRepo.list({ serviceCatalogId: internet.id, eventType: 'deactivated', from: rangeStart, to: rangeEndInstant }),
    ]);
    // fix-wave-4 🟡8 — dedup by contractId, same criterion as
    // `ComputeCacAndPayback`/`RankEarlyChurnByVendor` (a contract can
    // legitimately carry BOTH an 'activated' and a 'reactivated' event in the
    // same range) — one alta per CONTRACT, never one per event; otherwise the
    // SAME month shows a different alta count here than in `/cac` or
    // `/vendors/early-churn` for the exact same underlying sales.
    const seenAltaContracts = new Set<string>();
    const altaEvents = [...activated, ...reactivated].filter((e) => {
      if (seenAltaContracts.has(e.contractId)) return false;
      seenAltaContracts.add(e.contractId);
      return true;
    });
    const bajaEvents = deactivated;

    const allContractIds = [...new Set([...altaEvents, ...bajaEvents].map((e) => e.contractId))];
    const details = await this.contractRepo.findFinanceDetailsByIds(allContractIds);

    const byNode = new Map<string, NodeGrowthRow>();
    const nodeKey = (id: string | null) => id ?? '\0__unassigned__';
    const ensure = (networkSiteId: string | null, networkSiteName: string | null): NodeGrowthRow => {
      const key = nodeKey(networkSiteId);
      let row = byNode.get(key);
      if (!row) {
        row = { networkSiteId, networkSiteName, altas: 0, bajas: 0, netGrowth: 0 };
        byNode.set(key, row);
      }
      return row;
    };

    for (const e of altaEvents) {
      const d = details.get(e.contractId);
      ensure(d?.networkSiteId ?? null, d?.networkSiteName ?? null).altas += 1;
    }
    for (const e of bajaEvents) {
      const d = details.get(e.contractId);
      ensure(d?.networkSiteId ?? null, d?.networkSiteName ?? null).bajas += 1;
    }

    // fix-wave-4 🔵16 — deterministic tie-break: ASC by netGrowth (unchanged),
    // then ASC by `networkSiteId` (nulls — the "unassigned" bucket — sort
    // LAST) so equal-netGrowth nodes render in the same order every request
    // instead of depending on `Map` iteration order.
    const nodes = [...byNode.values()]
      .map((row) => ({ ...row, netGrowth: row.altas - row.bajas }))
      .sort((a, b) => {
        if (a.netGrowth !== b.netGrowth) return a.netGrowth - b.netGrowth;
        if (a.networkSiteId === null && b.networkSiteId === null) return 0;
        if (a.networkSiteId === null) return 1;
        if (b.networkSiteId === null) return -1;
        return a.networkSiteId.localeCompare(b.networkSiteId);
      });

    return { nodes };
  }
}
