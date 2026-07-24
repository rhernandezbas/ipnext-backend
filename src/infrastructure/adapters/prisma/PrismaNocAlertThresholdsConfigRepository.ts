import {
  NocAlertThresholdsConfig,
  NocAlertThresholdsConfigRepository,
  NOC_ALERT_THRESHOLDS_DEFAULTS,
} from '@domain/ports/NocAlertThresholdsConfigRepository';
import { prisma } from '../../database/prisma';

/** The single config row is always keyed by this id (schema `@default("singleton")`). */
const SINGLETON_ID = 'singleton';

interface ConfigRow {
  critDbm: number;
  warnDbm: number;
  deltaAlert: number;
  ponMinAbon: number;
  ponDelta: number;
}

function toConfig(row: ConfigRow): NocAlertThresholdsConfig {
  return {
    critDbm: row.critDbm,
    warnDbm: row.warnDbm,
    deltaAlert: row.deltaAlert,
    ponMinAbon: row.ponMinAbon,
    ponDelta: row.ponDelta,
  };
}

/**
 * F1 (noc-alerts-config) — Prisma adapter for the single-row fiber-alert
 * thresholds config. Uses the `(prisma as any)` accessor (molde
 * `PrismaNocBroadcastConfigRepository`) so it compiles before the client is
 * regenerated for the new table. `get()` returns the seeded defaults when the
 * singleton row is absent (shouldn't happen in prod — the migration seeds it
 * — but keeps the adapter correct even against a fresh/unmigrated DB in
 * tests). `update()` REPLACES the full config (no partial merge — the port's
 * contract, spec.md "Update validates required numeric fields").
 */
export class PrismaNocAlertThresholdsConfigRepository implements NocAlertThresholdsConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).nocAlertThresholdsConfig;
  }

  async get(): Promise<NocAlertThresholdsConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row ? toConfig(row) : { ...NOC_ALERT_THRESHOLDS_DEFAULTS };
  }

  async update(config: NocAlertThresholdsConfig): Promise<NocAlertThresholdsConfig> {
    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...config },
      update: { ...config },
    });
    return toConfig(row);
  }
}
