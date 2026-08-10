import {
  FinanceReceiptSyncConfig,
  FinanceReceiptSyncConfigRepository,
  FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS,
  normalizeFinanceReceiptSyncConfig,
} from '@domain/ports/FinanceReceiptSyncConfigRepository';

export class InMemoryFinanceReceiptSyncConfigRepository implements FinanceReceiptSyncConfigRepository {
  private config: FinanceReceiptSyncConfig | null = null;

  async get(): Promise<FinanceReceiptSyncConfig> {
    return normalizeFinanceReceiptSyncConfig(this.config ?? FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS);
  }

  async update(patch: Partial<FinanceReceiptSyncConfig>): Promise<FinanceReceiptSyncConfig> {
    const current = this.config ?? FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS;
    // gr-receipt-annulment (design.md Decision 7, U5) — normalized on the SAME
    // path as Prisma's `get()`, so `update({reconcileWindowDays: 0})` (a value
    // a caller could pass directly, mirroring a hand-edited SQL row) can never
    // silently persist an unsafe value in the double either.
    this.config = normalizeFinanceReceiptSyncConfig({ ...current, ...patch });
    return { ...this.config };
  }
}
