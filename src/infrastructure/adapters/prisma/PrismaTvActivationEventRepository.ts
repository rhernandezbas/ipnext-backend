import { prisma } from '@infrastructure/database/prisma';
import type {
  TvActivationEvent,
  TvActivationEventRepository,
  RecordTvActivationEventInput,
  ListTvActivationEventsFilter,
} from '@domain/ports/TvActivationEventRepository';

/**
 * PrismaTvActivationEventRepository — Prisma adapter for TvActivationEventRepository (#5 BE).
 *
 * Maps to the `TvActivationEvent` table (migration 20260721000000). Results are always
 * newest-first (createdAt DESC, id DESC as tie-break).
 */
export class PrismaTvActivationEventRepository implements TvActivationEventRepository {
  async record(input: RecordTvActivationEventInput): Promise<TvActivationEvent> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).tvActivationEvent.create({
      data: {
        clientId:   input.clientId,
        actorId:    input.actorId ?? null,
        actorName:  input.actorName,
        eventType:  input.eventType,
        cic:        input.cic ?? null,
        internalId: input.internalId ?? null,
        seq:        input.seq ?? null,
        contractId: input.contractId ?? null,
      },
    });
    return toEvent(row);
  }

  async listByClient(clientId: string): Promise<TvActivationEvent[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).tvActivationEvent.findMany({
      where:   { clientId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { client: { select: { name: true } } },
    });
    return rows.map(toEvent);
  }

  async list(filters: ListTvActivationEventsFilter): Promise<TvActivationEvent[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};
    if (filters.clientId) where['clientId'] = filters.clientId;
    if (filters.actorId)  where['actorId']  = filters.actorId;
    if (filters.from || filters.to) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createdAt: Record<string, any> = {};
      if (filters.from) createdAt['gte'] = filters.from;
      if (filters.to)   createdAt['lte'] = filters.to;
      where['createdAt'] = createdAt;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).tvActivationEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { client: { select: { name: true } } },
    });
    return rows.map(toEvent);
  }

  /** #110 — List events for a contract, newest first. */
  async listByContract(contractId: string): Promise<TvActivationEvent[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).tvActivationEvent.findMany({
      where:   { contractId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { client: { select: { name: true } } },
    });
    return rows.map(toEvent);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEvent(row: any): TvActivationEvent {
  return {
    id:           row.id,
    clientId:     row.clientId,
    customerName: row.client?.name ?? null,
    actorId:      row.actorId ?? null,
    actorName:    row.actorName,
    eventType:    row.eventType as TvActivationEvent['eventType'],
    cic:          row.cic ?? null,
    internalId:   row.internalId ?? null,
    seq:          row.seq ?? null,
    contractId:   row.contractId ?? null,
    createdAt:    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}
