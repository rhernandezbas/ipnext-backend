import type { SuricataVerdictRecord, CreateSuricataVerdictInput } from '@domain/entities/suricata';

/**
 * suricata-tickets-mirror (Phase D, task D.1, design D3/D9) — append-only:
 * `create` NEVER updates an existing row (VERDICT-4). `listByTicket` returns
 * the full history (training dataset); `latestByTicket` is what the panel and
 * KPIs read as "current" (VERDICT-5) — Phase F's read scope, but the method
 * lives here since it belongs to this port.
 */
export interface SuricataVerdictRepository {
  create(input: CreateSuricataVerdictInput): Promise<SuricataVerdictRecord>;
  listByTicket(ticketId: string): Promise<SuricataVerdictRecord[]>;
  /** Most recent verdict by `createdAt`, or `null` if the ticket has none yet. */
  latestByTicket(ticketId: string): Promise<SuricataVerdictRecord | null>;
}
