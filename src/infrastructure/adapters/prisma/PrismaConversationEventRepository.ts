import {
  ConversationEventRepository,
  ConversationEventRecord,
  RecordConversationEventInput,
  ResolutionsByDay,
  ConversationEventType,
} from '@domain/ports/ConversationEventRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): ConversationEventRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    type: row.type as ConversationEventType,
    actorId: row.actorId ?? null,
    fromValue: row.fromValue ?? null,
    toValue: row.toValue ?? null,
    createdAt: toIso(row.createdAt),
  };
}

/**
 * conversation-events (Ola 2) — Prisma adapter para `ConversationEventRepository`. No
 * unit-tested (misma convención que el resto de adapters Prisma del módulo): el contrato se
 * ejercita vía el port in-memory en los tests de use-case; acá se verifica en integración.
 *
 * TIMEZONE (ver `reportsTimezone.ts`): el bucketing por día se hace en zona AR con
 * `AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'` — equivalente EXACTO al
 * corrimiento -3h del helper in-memory (Argentina no tiene DST). El FILTRO por rango opera
 * sobre el instante crudo, `[fromIso, toIso)` semi-abierto.
 */
export class PrismaConversationEventRepository implements ConversationEventRepository {
  async record(input: RecordConversationEventInput): Promise<ConversationEventRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversationEvent.create({
      data: {
        conversationId: input.conversationId,
        type: input.type,
        actorId: input.actorId ?? null,
        fromValue: input.fromValue ?? null,
        toValue: input.toValue ?? null,
      },
    });
    return toDomain(row);
  }

  async countByTypeBetween(type: ConversationEventType, fromIso: string, toIso: string): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).conversationEvent.count({
      where: { type, createdAt: { gte: new Date(fromIso), lt: new Date(toIso) } },
    });
  }

  async resolvedCountByDay(fromIso: string, toIso: string): Promise<ResolutionsByDay[]> {
    // Anti-N+1: un solo GROUP BY. Día en zona AR (ver nota de timezone arriba).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Array<{ date: string; count: number }> = await (prisma as any).$queryRaw`
      SELECT to_char(
               (e."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
               'YYYY-MM-DD'
             ) AS date,
             COUNT(*)::int AS count
      FROM "ConversationEvent" e
      WHERE e."type" = 'resolved'
        AND (e."createdAt" AT TIME ZONE 'UTC') >= ${fromIso}::timestamptz
        AND (e."createdAt" AT TIME ZONE 'UTC') <  ${toIso}::timestamptz
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
  }

  async listByConversation(conversationId: string): Promise<ConversationEventRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).conversationEvent.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }
}
