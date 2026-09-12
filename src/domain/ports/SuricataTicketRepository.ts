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
}
