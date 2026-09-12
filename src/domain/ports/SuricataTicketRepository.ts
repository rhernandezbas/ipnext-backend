import type { SuricataTicketRecord, UpsertSuricataTicketInput } from '@domain/entities/suricata';

/**
 * suricata-tickets-mirror (Phase F, task F.1, design D3) — base filters for
 * the panel list. Every field is an EXACT match; omitted fields are not
 * filtered. `botState` is deliberately NOT here — it is a DERIVED value
 * (depends on the ticket's latest verdict, a different repository) applied
 * by `ListSuricataTickets`, which also owns sorting and pagination over the
 * set this method returns.
 */
export interface ListSuricataTicketsFilters {
  status?: string;
  priority?: string;
  areaId?: string;
  assigneeId?: string;
}

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
  /**
   * suricata-tickets-mirror (Phase F, task F.1/F.2, design D3) — ALL tickets
   * matching the given base filters, unpaged and unsorted. Also backs
   * `ComputeSuricataKpis` with an empty filter object (whole mirror).
   */
  list(filters: ListSuricataTicketsFilters): Promise<SuricataTicketRecord[]>;
  /**
   * suricata-tickets-mirror (Phase F, task F.1/F.2, spec UI-7) —
   * Prominense-ONLY assignment: a plain local UPDATE, NEVER a write to
   * Suricata. `assigneeId: null` clears the assignment. Assumes the caller
   * already verified the ticket exists (`SetSuricataAssignee` calls
   * `findById` first, same precedent as `markStored`/`markFailed` on the
   * attachment repo).
   */
  setAssignee(id: string, assigneeId: string | null): Promise<SuricataTicketRecord>;
}
