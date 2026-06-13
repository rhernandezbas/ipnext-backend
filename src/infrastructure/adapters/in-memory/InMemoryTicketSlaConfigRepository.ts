import {
  TicketSlaConfig,
  TicketSlaConfigRepository,
} from '@domain/ports/TicketSlaConfigRepository';

/** #79 — Hardcoded defaults returned before any row is persisted. */
const DEFAULTS: TicketSlaConfig = {
  warnMinutes: 60,
  dangerMinutes: 240,
};

/**
 * In-memory implementation of the ticket SLA timer config. Mirrors the Prisma
 * adapter's contract: `get()` returns defaults until something is persisted,
 * `update()` merges a partial patch and returns the resulting full config.
 */
export class InMemoryTicketSlaConfigRepository implements TicketSlaConfigRepository {
  private config: TicketSlaConfig | null = null;

  async get(): Promise<TicketSlaConfig> {
    const current = this.config ?? DEFAULTS;
    return { warnMinutes: current.warnMinutes, dangerMinutes: current.dangerMinutes };
  }

  async update(patch: Partial<TicketSlaConfig>): Promise<TicketSlaConfig> {
    const current = this.config ?? DEFAULTS;
    this.config = {
      warnMinutes: patch.warnMinutes ?? current.warnMinutes,
      dangerMinutes: patch.dangerMinutes ?? current.dangerMinutes,
    };
    return { warnMinutes: this.config.warnMinutes, dangerMinutes: this.config.dangerMinutes };
  }
}
