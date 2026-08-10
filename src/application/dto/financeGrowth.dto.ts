import { z } from 'zod';
import {
  FinanceInvoiceTypeBucket,
  FinanceInvoiceTypeClassification,
} from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';
import { FinanceTechnologyCostView } from '@application/use-cases/finance/GetFinanceTechnologyCosts';
import { FinancePlanPriceView } from '@application/use-cases/finance/GetFinancePlanPrices';
import { FinanceTargetsConfig } from '@domain/ports/FinanceTargetsConfigRepository';
import { FinanceInflationIndex } from '@domain/ports/FinanceInflationIndexRepository';
import type { GetFinanceOverviewResult } from '@application/use-cases/finance/GetFinanceOverview';
import type { GetFinanceCohortsResult } from '@application/use-cases/finance/GetFinanceCohorts';
import type { ComputeCacAndPaybackResult } from '@application/use-cases/finance/ComputeCacAndPayback';
import type { RankEarlyChurnByVendorResult } from '@application/use-cases/finance/RankEarlyChurnByVendor';
import type { RankNetGrowthByNodeResult } from '@application/use-cases/finance/RankNetGrowthByNode';
import type { RankCancellationReasonsResult } from '@application/use-cases/finance/RankCancellationReasonsByLostRevenue';

// ── GET /config/invoice-types ────────────────────────────────────────────

export interface FinanceInvoiceTypeDto {
  grType: string;
  bucket: FinanceInvoiceTypeBucket;
  label: string | null;
  updatedAt: string;
}

export function toFinanceInvoiceTypeDto(c: FinanceInvoiceTypeClassification): FinanceInvoiceTypeDto {
  return { grType: c.grType, bucket: c.bucket, label: c.label, updatedAt: c.updatedAt.toISOString() };
}

// ── PATCH /config/invoice-types/:grType ──────────────────────────────────

/**
 * `unclassified` is deliberately EXCLUDED from the enum — spec.md "`unclassified`
 * NO es un valor válido de entrada — es solo el default de sistema; intentar
 * setearlo explícitamente → 400". zod's enum already rejects it as an unknown value.
 */
export const ReclassifyFinanceInvoiceTypeSchema = z.object({
  bucket: z.enum(['revenue', 'contra', 'excluded']),
  label: z.string().optional(),
});
export type ReclassifyFinanceInvoiceTypeInput = z.infer<typeof ReclassifyFinanceInvoiceTypeSchema>;

// ── POST /sync/backfill-snapshots (finance-growth Fase 3 rework, J1) ──────

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const BackfillFinanceMonthlySnapshotsSchema = z.object({
  from: z.string().regex(YEAR_MONTH_RE, 'from debe tener formato "YYYY-MM"'),
  to: z.string().regex(YEAR_MONTH_RE, 'to debe tener formato "YYYY-MM"'),
});
export type BackfillFinanceMonthlySnapshotsInput = z.infer<typeof BackfillFinanceMonthlySnapshotsSchema>;

// ── GET /sync/status ──────────────────────────────────────────────────────

/**
 * Shape of the in-memory pacing snapshot (design.md Decision 4b). Owned HERE
 * (application layer, wire contract) even though the only implementation
 * lives in infrastructure (`FinanceReceiptIngestScheduler`) — infra depends
 * on this type, never the other way around.
 */
export interface FinancePacingStatusDto {
  requestIntervalMs: number;
  effectiveIntervalMs: number;
  degraded: boolean;
  consecutiveFailures: number;
  activeLane: 'delta' | 'reconcile' | 'backfill' | 'idle';
  /**
   * fix-wave-2 R3 — the LIVE `FinanceReceiptSyncConfig.enabled` kill-switch,
   * as last observed by a tick. Before this field existed, an operator who
   * flipped `enabled=false` saw a green status + `202 {started:true}` from
   * `POST /sync/run` with NO signal anywhere that the switch was off.
   */
  enabled: boolean;
}

export interface FinanceSyncStatusDto {
  pacing: FinancePacingStatusDto;
  delta: {
    lastRunAt: string | null;
    lastResult: string | null;
    itemsSynced: number;
    pendingPages: boolean;
    coveredThroughDate: string | null;
  };
  /** gr-receipt-annulment (design.md Decision 9) — third lane, same derive-from-SyncState shape as delta/backfill. */
  reconcile: {
    lastRunAt: string | null;
    lastResult: string | null;
    itemsSynced: number;
    sweepInProgress: boolean;
    windowFrom: string | null;
    windowTo: string | null;
    pageOffset: number;
  };
  backfill: {
    lastRunAt: string | null;
    lastResult: string | null;
    itemsSynced: number;
    cursorYearMonth: string | null;
    cursorPageOffset: number;
    done: boolean;
  };
  debtorBalances: {
    lastRunAt: string | null;
    lastResult: string | null;
    itemsSynced: number;
  };
  /**
   * finance-growth Fase 3 rework (J3) — before this field existed, the
   * nightly `FinanceSnapshotScheduler` had NO persisted state at all: its
   * errors went to `console.log` and a `runOnce()` return value nobody
   * consumed (`main.ts` fire-and-forget). If the job failed EVERY night, the
   * panel would show the last good month forever — indistinguishable from
   * "nothing changed", the same class of lie the user already flagged in
   * Fase 1 ("el status decía ok con el carril muerto"), except here there
   * wasn't even a status that COULD lie.
   */
  snapshotJob: {
    lastRunAt: string | null;
    lastResult: string | null;
    itemsSynced: number;
  };
}

export function toFinanceSyncStatusDto(
  status: FinanceSyncStatus,
  pacing: FinancePacingStatusDto,
): FinanceSyncStatusDto {
  return {
    pacing,
    delta: {
      lastRunAt: status.delta.lastRunAt?.toISOString() ?? null,
      lastResult: status.delta.lastResult,
      itemsSynced: status.delta.itemsSynced,
      pendingPages: status.delta.pendingPages,
      coveredThroughDate: status.delta.coveredThroughDate,
    },
    reconcile: {
      lastRunAt: status.reconcile.lastRunAt?.toISOString() ?? null,
      lastResult: status.reconcile.lastResult,
      itemsSynced: status.reconcile.itemsSynced,
      sweepInProgress: status.reconcile.sweepInProgress,
      windowFrom: status.reconcile.windowFrom,
      windowTo: status.reconcile.windowTo,
      pageOffset: status.reconcile.pageOffset,
    },
    backfill: {
      lastRunAt: status.backfill.lastRunAt?.toISOString() ?? null,
      lastResult: status.backfill.lastResult,
      itemsSynced: status.backfill.itemsSynced,
      cursorYearMonth: status.backfill.cursorYearMonth,
      cursorPageOffset: status.backfill.cursorPageOffset,
      done: status.backfill.done,
    },
    debtorBalances: {
      lastRunAt: status.debtorBalances.lastRunAt?.toISOString() ?? null,
      lastResult: status.debtorBalances.lastResult,
      itemsSynced: status.debtorBalances.itemsSynced,
    },
    snapshotJob: {
      lastRunAt: status.snapshotJob.lastRunAt?.toISOString() ?? null,
      lastResult: status.snapshotJob.lastResult,
      itemsSynced: status.snapshotJob.itemsSynced,
    },
  };
}

// ── Fase 2 — GET /config/technology-costs · PUT /config/technology-costs/:technologyName ──

export interface FinanceTechnologyCostDto {
  technologyName: string;
  costoVentaArs: number;
  costoInstalacionArs: number;
  costoMensualServicioArs: number;
  comisionVentaPct: number;
  updatedAt: string | null;
}

export function toFinanceTechnologyCostDto(v: FinanceTechnologyCostView): FinanceTechnologyCostDto {
  return {
    technologyName: v.technologyName,
    costoVentaArs: v.costoVentaArs,
    costoInstalacionArs: v.costoInstalacionArs,
    costoMensualServicioArs: v.costoMensualServicioArs,
    comisionVentaPct: v.comisionVentaPct,
    updatedAt: v.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Shape-only (required + numeric) validation for the PUT body — design.md
 * "los 4 campos son requeridos, numéricos". Business rules (>= 0, <= 100) are
 * enforced in `UpdateFinanceTechnologyCost` itself (unit-testable without an
 * HTTP layer, spec.md "sin aplicar actualizaciones parciales").
 */
export const UpdateFinanceTechnologyCostSchema = z.object({
  costoVentaArs: z.number(),
  costoInstalacionArs: z.number(),
  costoMensualServicioArs: z.number(),
  comisionVentaPct: z.number(),
});

// ── Fase 2 — GET /config/plan-prices · PUT /config/plan-prices/:planCode ──

export interface FinancePlanPriceDto {
  planCode: string;
  planName: string;
  estimatedMonthlyPrice: number;
  updatedAt: string | null;
}

export function toFinancePlanPriceDto(v: FinancePlanPriceView): FinancePlanPriceDto {
  return {
    planCode: v.planCode,
    planName: v.planName,
    estimatedMonthlyPrice: v.estimatedMonthlyPrice,
    updatedAt: v.updatedAt?.toISOString() ?? null,
  };
}

export const UpdateFinancePlanPriceSchema = z.object({
  estimatedMonthlyPrice: z.number(),
});

// ── Fase 2 — GET /config/targets · PUT /config/targets ──

export interface FinanceTargetsDto {
  churnTargetPct: number;
  maxPaybackMonths: number;
  monthlyNewContractsGoal: number;
  inflationBaseYearMonth: string;
}

export function toFinanceTargetsDto(c: FinanceTargetsConfig): FinanceTargetsDto {
  return {
    churnTargetPct: c.churnTargetPct,
    maxPaybackMonths: c.maxPaybackMonths,
    monthlyNewContractsGoal: c.monthlyNewContractsGoal,
    inflationBaseYearMonth: c.inflationBaseYearMonth,
  };
}

export const UpdateFinanceTargetsSchema = z.object({
  churnTargetPct: z.number(),
  maxPaybackMonths: z.number(),
  monthlyNewContractsGoal: z.number(),
  inflationBaseYearMonth: z.string(),
});

// ── Fase 2 — GET /config/inflation · PUT /config/inflation/:yearMonth ──

export interface FinanceInflationIndexDto {
  yearMonth: string;
  monthlyRatePct: number;
  source: string | null;
}

export function toFinanceInflationIndexDto(i: FinanceInflationIndex): FinanceInflationIndexDto {
  return { yearMonth: i.yearMonth, monthlyRatePct: i.monthlyRatePct, source: i.source };
}

export const UpdateFinanceInflationIndexSchema = z.object({
  monthlyRatePct: z.number(),
  source: z.string().optional(),
});

// ── Fase 4 — GET /overview?from=YYYY-MM&to=YYYY-MM ──────────────────────────
// design.md HTTP Contract, "GET /overview" (REWORK 2026-07-27, Decision 1b).
// Explicit field-by-field mapping (not an identity pass-through) — same
// boundary discipline as every other DTO in this file: the wire shape is
// pinned HERE, independent of whatever the use case's internal result type
// happens to carry.

export interface FinanceOverviewMonthDto {
  yearMonth: string;
  contractsActive: number;
  contractsNew: number;
  contractsChurned: number;
  contractsUpgraded: number;
  contractsDowngraded: number;
  mrrInicialArs: number;
  mrrNewArs: number;
  mrrUpgradeArs: number;
  mrrDowngradeArs: number;
  mrrChurnArs: number;
  mrrFinalArs: number;
  mrrFinalRealArs: number | null;
  bridgeResidualArs: number;
  unpricedContractsActive: number;
  unpricedContractsPct: number;
  unpricedPlanChangeEvents: number;
  enforcementPlanChangeEventsExcluded: number;
  revenueTotalArs: number;
  revenueTotalRealArs: number | null;
  collectionRatePct: number | null;
  revenueAttributableArs: number;
  unclassifiedAmountArs: number;
  attributionPct: number;
  arpuArs: number;
  churnContractsPct: number;
  churnRevenuePct: number | null;
}

export interface FinanceOverviewDto {
  months: FinanceOverviewMonthDto[];
  monthsWithoutSnapshot: string[];
  /** fix-wave-4 🔴1 — replaces `realSeriesTruncatedAt: string | null`. See `GetFinanceOverviewResult.realSeriesMissingMonths`'s docblock. */
  realSeriesMissingMonths: string[];
  inflationBaseYearMonth: string;
  metricBasis: 'cash_collected';
}

export function toFinanceOverviewDto(result: GetFinanceOverviewResult): FinanceOverviewDto {
  return {
    months: result.months.map((m) => ({
      yearMonth: m.yearMonth,
      contractsActive: m.contractsActive,
      contractsNew: m.contractsNew,
      contractsChurned: m.contractsChurned,
      contractsUpgraded: m.contractsUpgraded,
      contractsDowngraded: m.contractsDowngraded,
      mrrInicialArs: m.mrrInicialArs,
      mrrNewArs: m.mrrNewArs,
      mrrUpgradeArs: m.mrrUpgradeArs,
      mrrDowngradeArs: m.mrrDowngradeArs,
      mrrChurnArs: m.mrrChurnArs,
      mrrFinalArs: m.mrrFinalArs,
      mrrFinalRealArs: m.mrrFinalRealArs,
      bridgeResidualArs: m.bridgeResidualArs,
      unpricedContractsActive: m.unpricedContractsActive,
      unpricedContractsPct: m.unpricedContractsPct,
      unpricedPlanChangeEvents: m.unpricedPlanChangeEvents,
      enforcementPlanChangeEventsExcluded: m.enforcementPlanChangeEventsExcluded,
      revenueTotalArs: m.revenueTotalArs,
      revenueTotalRealArs: m.revenueTotalRealArs,
      collectionRatePct: m.collectionRatePct,
      revenueAttributableArs: m.revenueAttributableArs,
      unclassifiedAmountArs: m.unclassifiedAmountArs,
      attributionPct: m.attributionPct,
      arpuArs: m.arpuArs,
      churnContractsPct: m.churnContractsPct,
      churnRevenuePct: m.churnRevenuePct,
    })),
    monthsWithoutSnapshot: result.monthsWithoutSnapshot,
    realSeriesMissingMonths: result.realSeriesMissingMonths,
    inflationBaseYearMonth: result.inflationBaseYearMonth,
    metricBasis: result.metricBasis,
  };
}

// ── Fase 4 — GET /cohorts?fromCohort=YYYY-MM&toCohort=YYYY-MM ──────────────

export interface FinanceCohortSurvivalPointDto {
  survivingCount: number;
  pct: number;
}

export interface FinanceCohortRowDto {
  cohortYearMonth: string;
  originalCount: number;
  survival: {
    m3: FinanceCohortSurvivalPointDto | null;
    m6: FinanceCohortSurvivalPointDto | null;
    m12: FinanceCohortSurvivalPointDto | null;
  };
}

export interface FinanceCohortsDto {
  cohorts: FinanceCohortRowDto[];
  /** fix-wave-4 🟡9 — see `GetFinanceCohortsResult.monthsWithoutCohortSnapshot`'s docblock. */
  monthsWithoutCohortSnapshot: string[];
}

export function toFinanceCohortsDto(result: GetFinanceCohortsResult): FinanceCohortsDto {
  return {
    cohorts: result.cohorts.map((c) => ({
      cohortYearMonth: c.cohortYearMonth,
      originalCount: c.originalCount,
      survival: {
        m3: c.survival.m3 ? { survivingCount: c.survival.m3.survivingCount, pct: c.survival.m3.pct } : null,
        m6: c.survival.m6 ? { survivingCount: c.survival.m6.survivingCount, pct: c.survival.m6.pct } : null,
        m12: c.survival.m12 ? { survivingCount: c.survival.m12.survivingCount, pct: c.survival.m12.pct } : null,
      },
    })),
    monthsWithoutCohortSnapshot: result.monthsWithoutCohortSnapshot,
  };
}

// ── Fase 4 — GET /cac?technology=&yearMonth=YYYY-MM ─────────────────────────
// costConfigured/costoVentaArs/costoInstalacionArs/cacArs are nullable —
// see ComputeCacAndPayback's docblock ("no configurado" ≠ "cero").

export interface FinanceCacAltaDto {
  contractId: string;
  clientId: string;
  customerName: string | null;
  mrrAtribuidoArs: number;
  attributionConfidence: 'exact' | 'estimated' | 'estimated-equal';
  paybackMonths: number | null;
  lossMaking: boolean;
}

export interface FinanceCacDto {
  technology: string;
  costConfigured: boolean;
  /** fix-wave-4 🟡7 — see `ComputeCacAndPaybackResult.costIsZero`'s docblock. */
  costIsZero: boolean;
  costoVentaArs: number | null;
  costoInstalacionArs: number | null;
  cacArs: number | null;
  altasDelMes: FinanceCacAltaDto[];
  /** fix-wave-4 🔴2 — see `ComputeCacAndPaybackResult.altasDelMesSinTecnologia`'s docblock. */
  altasDelMesSinTecnologia: number;
  maxPaybackMonths: number;
}

export function toFinanceCacDto(result: ComputeCacAndPaybackResult): FinanceCacDto {
  return {
    technology: result.technology,
    costConfigured: result.costConfigured,
    costIsZero: result.costIsZero,
    costoVentaArs: result.costoVentaArs,
    costoInstalacionArs: result.costoInstalacionArs,
    cacArs: result.cacArs,
    altasDelMes: result.altasDelMes.map((a) => ({
      contractId: a.contractId,
      clientId: a.clientId,
      customerName: a.customerName,
      mrrAtribuidoArs: a.mrrAtribuidoArs,
      attributionConfidence: a.attributionConfidence,
      paybackMonths: a.paybackMonths,
      lossMaking: a.lossMaking,
    })),
    altasDelMesSinTecnologia: result.altasDelMesSinTecnologia,
    maxPaybackMonths: result.maxPaybackMonths,
  };
}

// ── Fase 4 — GET /vendors/early-churn?from=YYYY-MM&to=YYYY-MM ──────────────

export interface FinanceVendorEarlyChurnRowDto {
  vendedor: string;
  altasTotal: number;
  altasChurneadasTemprano: number;
  /** fix-wave-4 🟡5 — see `VendorEarlyChurnRow.altasMaduras`'s docblock; this is `earlyChurnPct`'s real denominator, NOT `altasTotal`. */
  altasMaduras: number;
  /** fix-wave-4 🟡5 — `null` when `altasMaduras` is 0 (no matured altas yet), never a guessed 0%. */
  earlyChurnPct: number | null;
}

export interface FinanceVendorEarlyChurnDto {
  windowMonths: number;
  vendors: FinanceVendorEarlyChurnRowDto[];
}

export function toFinanceVendorEarlyChurnDto(result: RankEarlyChurnByVendorResult): FinanceVendorEarlyChurnDto {
  return {
    windowMonths: result.windowMonths,
    vendors: result.vendors.map((v) => ({
      vendedor: v.vendedor,
      altasTotal: v.altasTotal,
      altasChurneadasTemprano: v.altasChurneadasTemprano,
      altasMaduras: v.altasMaduras,
      earlyChurnPct: v.earlyChurnPct,
    })),
  };
}

// ── Fase 4 — GET /nodes/growth?from=YYYY-MM&to=YYYY-MM ─────────────────────

export interface FinanceNodeGrowthRowDto {
  networkSiteId: string | null;
  networkSiteName: string | null;
  altas: number;
  bajas: number;
  netGrowth: number;
}

export interface FinanceNodeGrowthDto {
  nodes: FinanceNodeGrowthRowDto[];
}

export function toFinanceNodeGrowthDto(result: RankNetGrowthByNodeResult): FinanceNodeGrowthDto {
  return {
    nodes: result.nodes.map((n) => ({
      networkSiteId: n.networkSiteId,
      networkSiteName: n.networkSiteName,
      altas: n.altas,
      bajas: n.bajas,
      netGrowth: n.netGrowth,
    })),
  };
}

// ── Fase 4 — GET /motivos-baja?from=YYYY-MM&to=YYYY-MM ─────────────────────

export interface FinanceCancellationReasonRowDto {
  motivo: string;
  bajas: number;
  mrrPerdidoArs: number;
  /** fix-wave-4 🔴3 — see `CancellationReasonRow.bajasSinPrecio`'s docblock. */
  bajasSinPrecio: number;
}

export interface FinanceCancellationReasonsDto {
  motivos: FinanceCancellationReasonRowDto[];
}

export function toFinanceCancellationReasonsDto(result: RankCancellationReasonsResult): FinanceCancellationReasonsDto {
  return {
    motivos: result.motivos.map((m) => ({
      motivo: m.motivo,
      bajas: m.bajas,
      mrrPerdidoArs: m.mrrPerdidoArs,
      bajasSinPrecio: m.bajasSinPrecio,
    })),
  };
}
