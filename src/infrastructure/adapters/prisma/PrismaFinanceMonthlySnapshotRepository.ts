import {
  FinanceMonthlySnapshot,
  FinanceMonthlySnapshotRepository,
  FinanceMonthlySnapshotUpsert,
} from '@domain/ports/FinanceMonthlySnapshotRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntity(row: any): FinanceMonthlySnapshot {
  return {
    yearMonth: row.yearMonth,
    contractsActive: row.contractsActive,
    contractsNew: row.contractsNew,
    contractsChurned: row.contractsChurned,
    contractsUpgraded: row.contractsUpgraded,
    contractsDowngraded: row.contractsDowngraded,
    mrrInicialArs: Number(row.mrrInicialArs),
    mrrNewArs: Number(row.mrrNewArs),
    mrrUpgradeArs: Number(row.mrrUpgradeArs),
    mrrDowngradeArs: Number(row.mrrDowngradeArs),
    mrrChurnArs: Number(row.mrrChurnArs),
    mrrFinalArs: Number(row.mrrFinalArs),
    bridgeResidualArs: Number(row.bridgeResidualArs),
    unpricedContractsActive: row.unpricedContractsActive,
    unpricedContractsPct: Number(row.unpricedContractsPct),
    unpricedPlanChangeEvents: row.unpricedPlanChangeEvents,
    enforcementPlanChangeEventsExcluded: row.enforcementPlanChangeEventsExcluded,
    revenueTotalArs: Number(row.revenueTotalArs),
    collectionRatePct: row.collectionRatePct === null || row.collectionRatePct === undefined ? null : Number(row.collectionRatePct),
    revenueAttributableArs: Number(row.revenueAttributableArs),
    unclassifiedAmountArs: Number(row.unclassifiedAmountArs),
    attributionPct: Number(row.attributionPct),
    arpuArs: Number(row.arpuArs),
    churnContractsPct: Number(row.churnContractsPct),
    churnRevenuePct: row.churnRevenuePct === null || row.churnRevenuePct === undefined ? null : Number(row.churnRevenuePct),
    computedAt: row.computedAt,
  };
}

/**
 * finance-growth Fase 3 — Prisma adapter for `FinanceMonthlySnapshot`.
 * `upsert` replaces the WHOLE row (never a partial merge) — a re-run of
 * `BuildFinanceMonthlySnapshot` for a month is authoritative, not additive.
 */
export class PrismaFinanceMonthlySnapshotRepository implements FinanceMonthlySnapshotRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeMonthlySnapshot;
  }

  async get(yearMonth: string): Promise<FinanceMonthlySnapshot | null> {
    const row = await this.table.findUnique({ where: { yearMonth } });
    return row ? toEntity(row) : null;
  }

  async listRange(fromYearMonth: string, toYearMonth: string): Promise<FinanceMonthlySnapshot[]> {
    const rows = await this.table.findMany({
      where: { yearMonth: { gte: fromYearMonth, lte: toYearMonth } },
      orderBy: { yearMonth: 'asc' },
    });
    return rows.map(toEntity);
  }

  async upsert(yearMonth: string, data: Omit<FinanceMonthlySnapshotUpsert, 'yearMonth'>): Promise<FinanceMonthlySnapshot> {
    const payload = {
      contractsActive: data.contractsActive,
      contractsNew: data.contractsNew,
      contractsChurned: data.contractsChurned,
      contractsUpgraded: data.contractsUpgraded,
      contractsDowngraded: data.contractsDowngraded,
      mrrInicialArs: data.mrrInicialArs,
      mrrNewArs: data.mrrNewArs,
      mrrUpgradeArs: data.mrrUpgradeArs,
      mrrDowngradeArs: data.mrrDowngradeArs,
      mrrChurnArs: data.mrrChurnArs,
      mrrFinalArs: data.mrrFinalArs,
      bridgeResidualArs: data.bridgeResidualArs,
      unpricedContractsActive: data.unpricedContractsActive,
      unpricedContractsPct: data.unpricedContractsPct,
      unpricedPlanChangeEvents: data.unpricedPlanChangeEvents,
      enforcementPlanChangeEventsExcluded: data.enforcementPlanChangeEventsExcluded,
      revenueTotalArs: data.revenueTotalArs,
      collectionRatePct: data.collectionRatePct,
      revenueAttributableArs: data.revenueAttributableArs,
      unclassifiedAmountArs: data.unclassifiedAmountArs,
      attributionPct: data.attributionPct,
      arpuArs: data.arpuArs,
      churnContractsPct: data.churnContractsPct,
      churnRevenuePct: data.churnRevenuePct,
      computedAt: new Date(),
    };
    const row = await this.table.upsert({
      where: { yearMonth },
      create: { yearMonth, ...payload },
      update: payload,
    });
    return toEntity(row);
  }
}
