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
}
