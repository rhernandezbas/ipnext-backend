import type { SuricataTicketRecord, UpsertSuricataTicketInput } from '@domain/entities/suricata';

/**
 * Phase C scope only (backfill/incremental persistence). `list`/`kpis`/
 * `setAssignee` (design D3 table) are Phase F's panel-read scope and will
 * extend this interface — and both adapters — when that phase lands.
 */
export interface SuricataTicketRepository {
  /** Idempotent by `externalId` (D6.b) — insert-if-new, update otherwise. */
  upsertByExternalId(input: UpsertSuricataTicketInput): Promise<SuricataTicketRecord>;
  findByExternalId(externalId: string): Promise<SuricataTicketRecord | null>;
  /**
   * suricata-tickets-mirror (Phase E, task E.2) — resolves by the LOCAL id,
   * needed by the internal panel routes (`POST /tickets/:id/reply` and
   * Phase F's `GET /:id` / `PATCH /:id/assignee`), which address a ticket by
   * its Prominense-local id, never by Suricata's `externalId`.
   */
  findById(id: string): Promise<SuricataTicketRecord | null>;
}
