import type {
  SuricataAttachmentRecord,
  UpsertSuricataAttachmentInput,
  MarkSuricataAttachmentStoredInput,
  MarkSuricataAttachmentFailedInput,
} from '@domain/entities/suricata';

export interface ListRetriableSuricataAttachmentsOptions {
  /** Rows with `attempts >= maxAttempts` are abandoned (MEDIA-3 molde) — never listed. */
  maxAttempts: number;
}

export interface SuricataAttachmentRepository {
  /** Idempotent by `(ticketId, externalRef)` — the schema's `@@unique`. */
  upsertByExternalRef(input: UpsertSuricataAttachmentInput): Promise<SuricataAttachmentRecord>;
  listRetriable(options: ListRetriableSuricataAttachmentsOptions): Promise<SuricataAttachmentRecord[]>;
  markStored(id: string, input: MarkSuricataAttachmentStoredInput): Promise<SuricataAttachmentRecord>;
  /** Increments `attempts` by 1 and records `lastError` (never reverts a `stored` row). */
  markFailed(id: string, input: MarkSuricataAttachmentFailedInput): Promise<SuricataAttachmentRecord>;
  /**
   * suricata-tickets-mirror (Phase D, task D.6, design D7.c) — resolves a
   * single attachment by its LOCAL id, for the external content proxy route.
   * The route itself validates `record.ticketId` against the `externalId` in
   * the path (an id from another ticket must 404, never 200) — this method
   * stays dumb, same criterion as the rest of this port.
   */
  findById(id: string): Promise<SuricataAttachmentRecord | null>;
  /**
   * suricata-tickets-mirror (Phase F, task F.2, spec UI-3) — full attachment
   * list for a ticket's detail view (Conversation tab renders these inline,
   * grouped by `messageId`).
   */
  listByTicketId(ticketId: string): Promise<SuricataAttachmentRecord[]>;
}
