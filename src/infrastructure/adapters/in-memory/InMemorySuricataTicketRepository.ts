import { randomUUID } from 'crypto';
import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataTicketRecord, UpsertSuricataTicketInput } from '@domain/entities/suricata';

/** In-memory `SuricataTicketRepository` for use-case tests (D6.b idempotency). */
export class InMemorySuricataTicketRepository implements SuricataTicketRepository {
  private rows: SuricataTicketRecord[] = [];

  async upsertByExternalId(input: UpsertSuricataTicketInput): Promise<SuricataTicketRecord> {
    const existing = this.rows.find((r) => r.externalId === input.externalId);
    if (existing) {
      existing.subject = input.subject;
      existing.status = input.status;
      existing.priority = input.priority;
      existing.areaId = input.areaId;
      existing.customerName = input.customerName;
      existing.customerEmail = input.customerEmail;
      existing.customerPhone = input.customerPhone;
      existing.externalClientRef = input.externalClientRef;
      existing.clientId = input.clientId;
      existing.openedAt = input.openedAt;
      existing.lastMessageAt = input.lastMessageAt;
      existing.contentHash = input.contentHash;
      existing.syncedAt = input.syncedAt;
      return { ...existing };
    }
    const now = input.syncedAt;
    const row: SuricataTicketRecord = {
      id: randomUUID(),
      externalId: input.externalId,
      subject: input.subject,
      status: input.status,
      priority: input.priority,
      areaId: input.areaId,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      externalClientRef: input.externalClientRef,
      clientId: input.clientId,
      openedAt: input.openedAt,
      lastMessageAt: input.lastMessageAt,
      assigneeId: null,
      contentHash: input.contentHash,
      firstSyncedAt: now,
      syncedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async findByExternalId(externalId: string): Promise<SuricataTicketRecord | null> {
    const row = this.rows.find((r) => r.externalId === externalId);
    return row ? { ...row } : null;
  }

  async findById(id: string): Promise<SuricataTicketRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }
}
