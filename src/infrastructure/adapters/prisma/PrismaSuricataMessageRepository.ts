import type { SuricataMessageRepository } from '@domain/ports/SuricataMessageRepository';
import type { SuricataMessageRecord, UpsertSuricataMessageInput } from '@domain/entities/suricata';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataMessageRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    externalId: row.externalId,
    author: row.author,
    authorKind: row.authorKind,
    body: row.body,
    sentAt: toIso(row.sentAt),
  };
}

/**
 * suricata-tickets-mirror (Phase C, task C.5, D6.b) — Prisma adapter for
 * `SuricataMessageRepository`. Idempotent by `externalId` (schema `@unique`).
 */
export class PrismaSuricataMessageRepository implements SuricataMessageRepository {
  async upsertManyByExternalId(
    ticketId: string,
    rows: UpsertSuricataMessageInput[],
  ): Promise<SuricataMessageRecord[]> {
    const result = [];
    for (const input of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).suricataMessage.upsert({
        where: { externalId: input.externalId },
        create: {
          ticketId,
          externalId: input.externalId,
          author: input.author,
          authorKind: input.authorKind,
          body: input.body,
          sentAt: input.sentAt,
        },
        update: {
          author: input.author,
          authorKind: input.authorKind,
          body: input.body,
          sentAt: input.sentAt,
        },
      });
      result.push(toDomain(row));
    }
    return result;
  }

  async listByTicketId(ticketId: string): Promise<SuricataMessageRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataMessage.findMany({
      where: { ticketId },
      orderBy: { sentAt: 'asc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }
}
