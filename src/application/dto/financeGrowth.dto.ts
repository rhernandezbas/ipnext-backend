import { z } from 'zod';
import {
  FinanceInvoiceTypeBucket,
  FinanceInvoiceTypeClassification,
} from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';

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
  };
}
