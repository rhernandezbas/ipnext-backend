import type { SuricataMessageRecord, UpsertSuricataMessageInput } from '@domain/entities/suricata';

export interface SuricataMessageRepository {
  /** Idempotent by `externalId` per message — a re-fetched ticket never duplicates rows. */
  upsertManyByExternalId(
    ticketId: string,
    rows: UpsertSuricataMessageInput[],
  ): Promise<SuricataMessageRecord[]>;
  listByTicketId(ticketId: string): Promise<SuricataMessageRecord[]>;
}
