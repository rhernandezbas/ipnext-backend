import {
  FinanceReceiptSyncConfig,
  FinanceReceiptSyncConfigRepository,
  FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS,
} from '@domain/ports/FinanceReceiptSyncConfigRepository';

export class InMemoryFinanceReceiptSyncConfigRepository implements FinanceReceiptSyncConfigRepository {
  private config: FinanceReceiptSyncConfig | null = null;

  async get(): Promise<FinanceReceiptSyncConfig> {
    return { ...(this.config ?? FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS) };
  }

  async update(patch: Partial<FinanceReceiptSyncConfig>): Promise<FinanceReceiptSyncConfig> {
    const current = this.config ?? FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS;
    this.config = { ...current, ...patch };
    return { ...this.config };
  }
}
