import { randomUUID } from 'crypto';
import type {
  SuricataAttachmentRepository,
  ListRetriableSuricataAttachmentsOptions,
} from '@domain/ports/SuricataAttachmentRepository';
import type {
  SuricataAttachmentRecord,
  UpsertSuricataAttachmentInput,
  MarkSuricataAttachmentStoredInput,
  MarkSuricataAttachmentFailedInput,
} from '@domain/entities/suricata';
import { SuricataAttachmentNotFoundError } from '@domain/errors/suricata';

/** In-memory `SuricataAttachmentRepository` for use-case tests (D7, MEDIA-3 molde). */
export class InMemorySuricataAttachmentRepository implements SuricataAttachmentRepository {
  private rows: SuricataAttachmentRecord[] = [];

  async upsertByExternalRef(input: UpsertSuricataAttachmentInput): Promise<SuricataAttachmentRecord> {
    const existing = this.rows.find(
      (r) => r.ticketId === input.ticketId && r.externalRef === input.externalRef,
    );
    if (existing) {
      existing.messageId = input.messageId;
      existing.fileName = input.fileName;
      existing.mimeType = input.mimeType ?? existing.mimeType;
      existing.sizeBytes = input.sizeBytes ?? existing.sizeBytes;
      return { ...existing };
    }
    const row: SuricataAttachmentRecord = {
      id: randomUUID(),
      ticketId: input.ticketId,
      messageId: input.messageId,
      externalRef: input.externalRef,
      fileName: input.fileName,
      mimeType: input.mimeType ?? 'application/octet-stream',
      sizeBytes: input.sizeBytes ?? null,
      sha256: null,
      storageKey: null,
      status: 'pending',
      attempts: 0,
      lastError: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async listRetriable(options: ListRetriableSuricataAttachmentsOptions): Promise<SuricataAttachmentRecord[]> {
    return this.rows
      .filter((r) => r.status !== 'stored' && r.attempts < options.maxAttempts)
      .map((r) => ({ ...r }));
  }

  async markStored(id: string, input: MarkSuricataAttachmentStoredInput): Promise<SuricataAttachmentRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new SuricataAttachmentNotFoundError(id);
    row.status = 'stored';
    row.sha256 = input.sha256;
    row.storageKey = input.storageKey;
    row.sizeBytes = input.sizeBytes;
    row.lastError = null;
    return { ...row };
  }

  async markFailed(id: string, input: MarkSuricataAttachmentFailedInput): Promise<SuricataAttachmentRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new SuricataAttachmentNotFoundError(id);
    // Molde ChatMessageAttachment fix-be #2 — never revert an already-`stored` row.
    if (row.status === 'stored') return { ...row };
    row.status = 'failed';
    row.attempts += 1;
    row.lastError = input.error;
    return { ...row };
  }

  async findById(id: string): Promise<SuricataAttachmentRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async listByTicketId(ticketId: string): Promise<SuricataAttachmentRecord[]> {
    return this.rows.filter((r) => r.ticketId === ticketId).map((r) => ({ ...r }));
  }
}
