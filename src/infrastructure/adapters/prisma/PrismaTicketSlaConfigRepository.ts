import {
  TicketSlaConfig,
  TicketSlaConfigRepository,
} from '@domain/ports/TicketSlaConfigRepository';
import { prisma } from '../../database/prisma';

/** The single config row is always keyed by this id (schema `@default("singleton")`). */
const SINGLETON_ID = 'singleton';

/** #79 — Hardcoded defaults returned before the singleton row exists. */
const DEFAULTS: TicketSlaConfig = {
  warnMinutes: 60,
  dangerMinutes: 240,
};

/**
 * Prisma adapter for the single-row ticket SLA timer config. Uses `(prisma as any)`
 * because the generated client may not be regenerated locally for this new table
 * (mirrors PrismaIClassClosureConfigRepository). `get()` returns defaults when the
 * singleton row is absent; `update()` upserts and returns the resulting full config.
 */
export class PrismaTicketSlaConfigRepository implements TicketSlaConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).ticketSlaConfig;
  }

  async get(): Promise<TicketSlaConfig> {
    const row: TicketSlaConfig | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row
      ? { warnMinutes: row.warnMinutes, dangerMinutes: row.dangerMinutes }
      : { ...DEFAULTS };
  }

  async update(patch: Partial<TicketSlaConfig>): Promise<TicketSlaConfig> {
    const data: Partial<TicketSlaConfig> = {};
    if (patch.warnMinutes !== undefined) data.warnMinutes = patch.warnMinutes;
    if (patch.dangerMinutes !== undefined) data.dangerMinutes = patch.dangerMinutes;

    const row: TicketSlaConfig = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        warnMinutes: data.warnMinutes ?? DEFAULTS.warnMinutes,
        dangerMinutes: data.dangerMinutes ?? DEFAULTS.dangerMinutes,
      },
      update: data,
    });
    return { warnMinutes: row.warnMinutes, dangerMinutes: row.dangerMinutes };
  }
}
