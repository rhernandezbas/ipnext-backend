import type {
  SuricataTicketRepository,
  ListSuricataTicketsFilters,
} from '@domain/ports/SuricataTicketRepository';
import type { SuricataTicketRecord, UpsertSuricataTicketInput } from '@domain/entities/suricata';
import { SuricataTicketNotFoundError } from '@domain/errors/suricata';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoOrNull(value: any): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataTicketRecord {
  return {
    id: row.id,
    externalId: row.externalId,
    subject: row.subject,
    status: row.status,
    priority: row.priority ?? null,
    areaId: row.areaId ?? null,
    customerName: row.customerName ?? null,
    customerEmail: row.customerEmail ?? null,
    customerPhone: row.customerPhone ?? null,
    externalClientRef: row.externalClientRef ?? null,
    clientId: row.clientId ?? null,
    openedAt: toIsoOrNull(row.openedAt),
    lastMessageAt: toIsoOrNull(row.lastMessageAt),
    assigneeId: row.assigneeId ?? null,
    contentHash: row.contentHash,
    firstSyncedAt: toIso(row.firstSyncedAt),
    syncedAt: toIso(row.syncedAt),
  };
}

/**
 * suricata-tickets-mirror (Phase C, task C.5, D6.b) — Prisma adapter for
 * `SuricataTicketRepository`. Phase C scope only (backfill/incremental
 * persistence) — `list`/`kpis`/`setAssignee` (design D3 table) are Phase F's
 * panel-read scope and will extend this class when that phase lands.
 */
export class PrismaSuricataTicketRepository implements SuricataTicketRepository {
  async upsertByExternalId(input: UpsertSuricataTicketInput): Promise<SuricataTicketRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataTicket.upsert({
      where: { externalId: input.externalId },
      create: {
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
        contentHash: input.contentHash,
        syncedAt: input.syncedAt,
      },
      update: {
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
        contentHash: input.contentHash,
        syncedAt: input.syncedAt,
      },
    });
    return toDomain(row);
  }

  async findByExternalId(externalId: string): Promise<SuricataTicketRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataTicket.findUnique({ where: { externalId } });
    return row ? toDomain(row) : null;
  }

  async findById(id: string): Promise<SuricataTicketRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataTicket.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async list(filters: ListSuricataTicketsFilters): Promise<SuricataTicketRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataTicket.findMany({
      where: {
        ...(filters.status !== undefined ? { status: filters.status } : {}),
        ...(filters.priority !== undefined ? { priority: filters.priority } : {}),
        ...(filters.areaId !== undefined ? { areaId: filters.areaId } : {}),
        ...(filters.assigneeId !== undefined ? { assigneeId: filters.assigneeId } : {}),
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async setAssignee(id: string, assigneeId: string | null): Promise<SuricataTicketRecord> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).suricataTicket.update({
        where: { id },
        data: { assigneeId },
      });
      return toDomain(row);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2025') throw new SuricataTicketNotFoundError(id);
      throw e;
    }
  }
}
