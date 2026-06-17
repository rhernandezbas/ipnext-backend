import { prisma } from '@infrastructure/database/prisma';
import type {
  ContractServiceEvent,
  ContractServiceEventRepository,
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
