import type { SuricataVerdictRepository } from '@domain/ports/SuricataVerdictRepository';
import type { SuricataVerdictRecord, CreateSuricataVerdictInput } from '@domain/entities/suricata';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataVerdictRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    resuelto: row.resuelto,
    analisis: row.analisis,
    motivo: row.motivo ?? null,
    respuestaSugerida: row.respuestaSugerida ?? null,
    ticketContentHash: row.ticketContentHash,
    submittedBy: row.submittedBy,
    createdAt: toIso(row.createdAt),
  };
}

/**
 * suricata-tickets-mirror (Phase D, task D.1, D9) — Prisma adapter for
 * `SuricataVerdictRepository`. `create` is a plain INSERT, never an
 * upsert/update (VERDICT-4 append-only), `tsc`-verified only (no local DB,
 * repo convention).
 */
export class PrismaSuricataVerdictRepository implements SuricataVerdictRepository {
  async create(input: CreateSuricataVerdictInput): Promise<SuricataVerdictRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataTicketVerdict.create({
      data: {
        ticketId: input.ticketId,
        resuelto: input.resuelto,
        analisis: input.analisis,
        motivo: input.motivo,
        respuestaSugerida: input.respuestaSugerida,
        ticketContentHash: input.ticketContentHash,
        submittedBy: input.submittedBy,
      },
    });
    return toDomain(row);
  }

  async listByTicket(ticketId: string): Promise<SuricataVerdictRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataTicketVerdict.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async latestByTicket(ticketId: string): Promise<SuricataVerdictRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataTicketVerdict.findFirst({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toDomain(row) : null;
  }

  async latestByTicketIds(ticketIds: string[]): Promise<Map<string, SuricataVerdictRecord>> {
    if (ticketIds.length === 0) return new Map();
    // ONE query for every ticket id (task F.1 — never N+1); ascending order so
    // the last write per ticketId in the reduce below is always the newest.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataTicketVerdict.findMany({
      where: { ticketId: { in: ticketIds } },
      orderBy: { createdAt: 'asc' },
    });
    const result = new Map<string, SuricataVerdictRecord>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of rows as any[]) {
      result.set(row.ticketId, toDomain(row));
    }
    return result;
  }
}
