import { randomUUID } from 'crypto';
import type { SuricataMessageRepository } from '@domain/ports/SuricataMessageRepository';
import type { SuricataMessageRecord, UpsertSuricataMessageInput } from '@domain/entities/suricata';

/** In-memory `SuricataMessageRepository` for use-case tests (dedup by `externalId`). */
export class InMemorySuricataMessageRepository implements SuricataMessageRepository {
  private rows: SuricataMessageRecord[] = [];

  async upsertManyByExternalId(
    ticketId: string,
    inputRows: UpsertSuricataMessageInput[],
  ): Promise<SuricataMessageRecord[]> {
    return Promise.all(
      inputRows.map((input) => {
        const existing = this.rows.find((r) => r.externalId === input.externalId);
        if (existing) {
          existing.author = input.author;
          existing.authorKind = input.authorKind;
          existing.body = input.body;
          existing.sentAt = input.sentAt;
          return { ...existing };
        }
        const row: SuricataMessageRecord = {
          id: randomUUID(),
          ticketId,
          externalId: input.externalId,
          author: input.author,
          authorKind: input.authorKind,
          body: input.body,
          sentAt: input.sentAt,
        };
        this.rows.push(row);
        return { ...row };
      }),
    );
  }

  async listByTicketId(ticketId: string): Promise<SuricataMessageRecord[]> {
    return this.rows.filter((r) => r.ticketId === ticketId).map((r) => ({ ...r }));
  }
}
