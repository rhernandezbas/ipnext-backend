import {
  FinanceReceiptSyncConfig,
  FinanceReceiptSyncConfigRepository,
  FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS,
  normalizeFinanceReceiptSyncConfig,
} from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { prisma } from '../../database/prisma';

const SINGLETON_ID = 'singleton';

interface ConfigRow {
  enabled: boolean;
  requestIntervalMs: number;
  maxRequestIntervalMs: number;
  deltaCheckIntervalMs: number;
  backfillFloorYearMonth: string;
  deltaStarvationThreshold: number;
  reconcileEnabled: boolean;
  reconcileWindowDays: number;
  reconcileCheckIntervalMs: number;
  annulmentGuardMaxPct: number;
  annulmentGuardMinCount: number;
}

/** gr-receipt-annulment (design.md Decision 7) — a raw DB row is UNTRUSTED (a hand-edited SQL row can carry anything); normalize it before it reaches the scheduler/use cases. */
function toConfig(row: ConfigRow): FinanceReceiptSyncConfig {
  return normalizeFinanceReceiptSyncConfig({
    enabled: row.enabled,
    requestIntervalMs: row.requestIntervalMs,
    maxRequestIntervalMs: row.maxRequestIntervalMs,
    deltaCheckIntervalMs: row.deltaCheckIntervalMs,
    backfillFloorYearMonth: row.backfillFloorYearMonth,
    deltaStarvationThreshold: row.deltaStarvationThreshold,
    reconcileEnabled: row.reconcileEnabled,
    reconcileWindowDays: row.reconcileWindowDays,
    reconcileCheckIntervalMs: row.reconcileCheckIntervalMs,
    annulmentGuardMaxPct: row.annulmentGuardMaxPct,
    annulmentGuardMinCount: row.annulmentGuardMinCount,
  });
}

/**
 * finance-growth Fase 1 — Prisma adapter for the single-row receipt-ingest
 * pacing config (design.md Decision 4b). Molde `PrismaNocAlertThresholdsConfigRepository`.
 */
export class PrismaFinanceReceiptSyncConfigRepository implements FinanceReceiptSyncConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeReceiptSyncConfig;
  }

  async get(): Promise<FinanceReceiptSyncConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row ? toConfig(row) : { ...FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS };
  }

  async update(patch: Partial<FinanceReceiptSyncConfig>): Promise<FinanceReceiptSyncConfig> {
    const current = await this.get();
    const merged = { ...current, ...patch };
    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...merged },
      update: { ...patch },
    });
    return toConfig(row);
  }
}
