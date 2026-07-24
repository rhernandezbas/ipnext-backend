import {
  NocAlertThresholdsConfig,
  NocAlertThresholdsConfigRepository,
  NOC_ALERT_THRESHOLDS_DEFAULTS,
} from '@domain/ports/NocAlertThresholdsConfigRepository';

/**
 * F1 (noc-alerts-config) — in-memory single-row thresholds config. Mirrors
 * the Prisma adapter's contract: `get()` returns the seeded defaults until
 * something is persisted; `update()` REPLACES the full config (no partial
 * merge — see the port's doc comment).
 */
export class InMemoryNocAlertThresholdsConfigRepository implements NocAlertThresholdsConfigRepository {
  private config: NocAlertThresholdsConfig | null = null;

  async get(): Promise<NocAlertThresholdsConfig> {
    return { ...(this.config ?? NOC_ALERT_THRESHOLDS_DEFAULTS) };
  }

  async update(config: NocAlertThresholdsConfig): Promise<NocAlertThresholdsConfig> {
    this.config = { ...config };
    return { ...this.config };
  }
}
