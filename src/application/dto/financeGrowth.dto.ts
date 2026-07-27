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
  activeLane: 'delta' | 'backfill' | 'idle';
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
