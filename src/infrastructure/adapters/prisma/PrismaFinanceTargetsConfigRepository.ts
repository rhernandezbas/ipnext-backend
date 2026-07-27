import {
  FINANCE_TARGETS_CONFIG_DEFAULTS,
  FinanceTargetsConfig,
  FinanceTargetsConfigPatch,
  FinanceTargetsConfigRepository,
} from '@domain/ports/FinanceTargetsConfigRepository';
import { prisma } from '../../database/prisma';

const SINGLETON_ID = 'singleton';

interface ConfigRow {
  churnTargetPct: unknown; // Prisma.Decimal
  maxPaybackMonths: number;
  monthlyNewContractsGoal: number;
  inflationBaseYearMonth: string;
}

function toEntity(row: ConfigRow): FinanceTargetsConfig {
  return {
    churnTargetPct: Number(row.churnTargetPct),
    maxPaybackMonths: row.maxPaybackMonths,
    monthlyNewContractsGoal: row.monthlyNewContractsGoal,
    inflationBaseYearMonth: row.inflationBaseYearMonth,
  };
}

/**
 * finance-growth Fase 2 — Prisma adapter for the `FinanceTargetsConfig`
 * singleton row (molde `PrismaFinanceReceiptSyncConfigRepository`). The
 * migration seeds `{id: 'singleton'}` with the design.md defaults
 * (`ON CONFLICT DO NOTHING`); this adapter ALSO falls back to
 * `FINANCE_TARGETS_CONFIG_DEFAULTS` if that row is ever missing (e.g. a
 * fresh DB the seed hasn't reached yet), so `GetFinanceTargets` never 500s.
 */
export class PrismaFinanceTargetsConfigRepository implements FinanceTargetsConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeTargetsConfig;
  }

  async get(): Promise<FinanceTargetsConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row ? toEntity(row) : { ...FINANCE_TARGETS_CONFIG_DEFAULTS };
  }

  async update(patch: FinanceTargetsConfigPatch): Promise<FinanceTargetsConfig> {
    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...patch },
      update: { ...patch },
    });
    return toEntity(row);
  }
}
