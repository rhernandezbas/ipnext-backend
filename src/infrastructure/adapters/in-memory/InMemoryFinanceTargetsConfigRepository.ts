import {
  FINANCE_TARGETS_CONFIG_DEFAULTS,
  FinanceTargetsConfig,
  FinanceTargetsConfigPatch,
  FinanceTargetsConfigRepository,
} from '@domain/ports/FinanceTargetsConfigRepository';

/** finance-growth Fase 2 — in-memory test double for the singleton targets config. */
export class InMemoryFinanceTargetsConfigRepository implements FinanceTargetsConfigRepository {
  private row: FinanceTargetsConfig | null = null;

  async get(): Promise<FinanceTargetsConfig> {
    return this.row ? { ...this.row } : { ...FINANCE_TARGETS_CONFIG_DEFAULTS };
  }

  async update(patch: FinanceTargetsConfigPatch): Promise<FinanceTargetsConfig> {
    this.row = { ...patch };
    return { ...this.row };
  }

  /** Test seam. */
  seed(row: FinanceTargetsConfig): void {
    this.row = { ...row };
  }
}
