import { prisma } from '@infrastructure/database/prisma';
import type {
  ContractServiceEvent,
  ContractServiceEventWithClient,
  ContractServiceEventRepository,
  ListContractServiceEventsFilter,
  RecordContractServiceEventInput,
} from '@domain/ports/ContractServiceEventRepository';

/**
 * PrismaContractServiceEventRepository — Prisma adapter for ContractServiceEventRepository (#110).
 *
 * Maps to the `contract_service_events` table (migration 20260722000000). Results are
 * always newest-first (createdAt DESC, id DESC as tie-break).
 *
 * Uses `(prisma as any).contractServiceEvent` because the Prisma client is not
 * regenerated in the shared worktree node_modules junction. The Dockerfile regenerates
 * the client in production.
 */
export class PrismaContractServiceEventRepository implements ContractServiceEventRepository {
  async record(input: RecordContractServiceEventInput): Promise<ContractServiceEvent> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).contractServiceEvent.create({
      data: {
        contractId:       input.contractId,
        serviceCatalogId: input.serviceCatalogId,
        eventType:        input.eventType,
        actorId:          input.actorId ?? null,
        actorName:        input.actorName ?? '',
        notes:            input.notes ?? null,
        reason:           input.reason ?? null,
      },
    });
    return toEvent(row);
  }

  async listByContract(contractId: string): Promise<ContractServiceEvent[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).contractServiceEvent.findMany({
      where:   { contractId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // #117 — JOIN al operador: resuelve actorName vacío vía actor.login (patrón #106)
      include: { actor: { select: { login: true } } },
    });
    return rows.map(toEvent);
  }

  async list(filters: ListContractServiceEventsFilter): Promise<ContractServiceEventWithClient[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};
    if (filters.serviceCatalogId) where['serviceCatalogId'] = filters.serviceCatalogId;
    // push-down: `contractIds` scopes to the page's contracts (SQL `contractId IN (...)`) so the
    // createdBy enrichment is bounded by the page, NOT by the full historical event count.
    // A single `contractId` filter takes precedence (it's the narrower predicate).
    if (filters.contractId)       where['contractId']       = filters.contractId;
    else if (filters.contractIds) where['contractId']       = { in: filters.contractIds };
    if (filters.actorId)          where['actorId']          = filters.actorId;
    // clientId lives on Contract — filter through the relation.
    if (filters.clientId) where['contract'] = { clientId: filters.clientId };
    if (filters.from || filters.to) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createdAt: Record<string, any> = {};
      if (filters.from) createdAt['gte'] = filters.from;
      if (filters.to)   createdAt['lte'] = filters.to;
      where['createdAt'] = createdAt;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).contractServiceEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // JOIN al operador (actorName fallback) + JOIN contract→client (clientId + customerName).
      include: {
        actor: { select: { login: true } },
        contract: { select: { clientId: true, client: { select: { name: true } } } },
      },
    });
    return rows.map(toEventWithClient);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEventWithClient(row: any): ContractServiceEventWithClient {
  return {
    ...toEvent(row),
    clientId:     row.contract?.clientId ?? null,
    customerName: row.contract?.client?.name ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEvent(row: any): ContractServiceEvent {
  return {
    id:               row.id,
    contractId:       row.contractId,
    serviceCatalogId: row.serviceCatalogId,
    eventType:        row.eventType as ContractServiceEvent['eventType'],
    actorId:          row.actorId ?? null,
    // #117 — 3-branch fallback: snapshot (sobrevive rename/delete) || JOIN actor.login (eventos viejos sin snapshot) || ''
    actorName:        row.actorName || row.actor?.login || '',
    notes:            row.notes ?? null,
    reason:           row.reason ?? null,
    createdAt:        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}
