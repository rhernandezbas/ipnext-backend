/**
 * #79 — Persisted SLA timer thresholds for the tickets list "Timer" column.
 * Backed by a single-row table; `get()` returns hardcoded defaults when no row
 * exists. The thresholds drive the client-side color of the elapsed-time pill:
 * green below `warnMinutes`, amber up to `dangerMinutes`, red beyond.
 */
export interface TicketSlaConfig {
  /** Minutes elapsed since createdAt at which the timer turns amber. Default: 60. */
  warnMinutes: number;
  /** Minutes elapsed at which the timer turns red. Default: 240. Must be > warnMinutes. */
  dangerMinutes: number;
}

/**
 * Port for reading/updating the ticket SLA timer config.
 * Application layer depends on this; Prisma/InMemory adapters implement it.
 */
export interface TicketSlaConfigRepository {
  /** Current config; returns defaults if no row has been persisted yet. */
  get(): Promise<TicketSlaConfig>;
  /** Apply a partial patch and return the resulting full config. Omitted fields are untouched. */
  update(patch: Partial<TicketSlaConfig>): Promise<TicketSlaConfig>;
}
