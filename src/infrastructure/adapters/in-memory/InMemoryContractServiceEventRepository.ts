import { randomUUID } from 'crypto';
import type {
  ContractServiceEvent,
  ContractServiceEventWithClient,
  ContractServiceEventOperator,
  ContractServiceEventRepository,
  ListContractServiceEventsFilter,
  RecordContractServiceEventInput,
} from '@domain/ports/ContractServiceEventRepository';

/**
 * InMemoryContractServiceEventRepository — test seam for ContractServiceEventRepository (#110).
 *
 * Array-backed, newest-first (createdAt DESC). Injectable `now()` for deterministic
 * ordering in tests.
 *
 * internet-history: list(filters) needs the contract's client (clientId + customerName),
 * which the repo can't derive on its own. Tests seed the cross via setContractClient();
 * in prod the JOIN contract→client is done by Prisma.
 */
export class InMemoryContractServiceEventRepository implements ContractServiceEventRepository {
  private readonly store: ContractServiceEvent[] = [];
  private readonly contractClient = new Map<string, { clientId: string | null; customerName: string | null }>();
  private _lastListFilter: ListContractServiceEventsFilter | undefined;
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  /** Test seam: associate a contractId with its client (for list() enrichment). */
  setContractClient(contractId: string, clientId: string | null, customerName: string | null): void {
    this.contractClient.set(contractId, { clientId, customerName });
  }

  /** Test seam: the filter passed to the last list() call (to assert push-down scoping). */
  lastListFilter(): ListContractServiceEventsFilter | undefined {
    return this._lastListFilter;
  }

  async record(input: RecordContractServiceEventInput): Promise<ContractServiceEvent> {
    const event: ContractServiceEvent = {
      id:               randomUUID(),
      contractId:       input.contractId,
      serviceCatalogId: input.serviceCatalogId,
      eventType:        input.eventType,
      actorId:          input.actorId ?? null,
      actorName:        input.actorName ?? '',
      notes:            input.notes ?? null,
      oldPlan:          input.oldPlan ?? null,
      newPlan:          input.newPlan ?? null,
      reason:           input.reason ?? null,
      createdAt:        this.now().toISOString(),
    };
    this.store.push(event);
    return { ...event };
  }

  async listByContract(contractId: string): Promise<ContractServiceEvent[]> {
    return this.store
      .filter(e => e.contractId === contractId)
      .sort(newestFirst)
      .map(e => ({ ...e }));
  }

  async list(filters: ListContractServiceEventsFilter): Promise<ContractServiceEventWithClient[]> {
    this._lastListFilter = { ...filters };
    const contractIdSet = filters.contractIds ? new Set(filters.contractIds) : undefined;
    const enrich = (e: ContractServiceEvent): ContractServiceEventWithClient => {
      const client = this.contractClient.get(e.contractId);
      return {
        ...e,
        clientId: client?.clientId ?? null,
        customerName: client?.customerName ?? null,
      };
    };
    return this.store
      .filter(e => {
        if (filters.serviceCatalogId && e.serviceCatalogId !== filters.serviceCatalogId) return false;
        if (filters.eventType && e.eventType !== filters.eventType) return false;
        if (filters.contractId && e.contractId !== filters.contractId) return false;
        if (contractIdSet && !contractIdSet.has(e.contractId)) return false;
        if (filters.actorId && e.actorId !== filters.actorId) return false;
        if (filters.clientId) {
          const client = this.contractClient.get(e.contractId);
          if (!client || client.clientId !== filters.clientId) return false;
        }
        if (filters.from && new Date(e.createdAt) < filters.from) return false;
        if (filters.to && new Date(e.createdAt) > filters.to) return false;
        return true;
      })
      .sort(newestFirst)
      .map(enrich);
  }

  async listDistinctOperators(filters: { serviceCatalogId?: string }): Promise<ContractServiceEventOperator[]> {
    // Dedup por actorId quedándose con el actorName NO vacío más RECIENTE (espeja al Prisma:
    // DISTINCT ON (actorId) ORDER BY createdAt desc + descarte de nombres vacíos). Un operador
    // cuyos eventos tienen TODOS actorName vacío queda fuera acá (el fallback a actor.login del
    // nombre es Prisma-only; el in-memory no modela el JOIN al actor).
    const best = new Map<string, { name: string; at: string }>();
    for (const e of this.store) {
      if (filters.serviceCatalogId && e.serviceCatalogId !== filters.serviceCatalogId) continue;
      if (!e.actorId || !e.actorName) continue;
      const cur = best.get(e.actorId);
      if (!cur || e.createdAt > cur.at) best.set(e.actorId, { name: e.actorName, at: e.createdAt });
    }
    return [...best.entries()]
      .map(([actorId, v]) => ({ actorId, actorName: v.name }))
      .sort((a, b) => a.actorName.localeCompare(b.actorName, 'es'));
  }

  /** For test assertions: expose all stored events (unfiltered). */
  all(): ContractServiceEvent[] {
    return this.store.map(e => ({ ...e }));
  }
}

function newestFirst(a: ContractServiceEvent, b: ContractServiceEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id > b.id ? -1 : 1;
}
