import { randomUUID } from 'crypto';
import type {
  ContractServiceEvent,
  ContractServiceEventRepository,
  RecordContractServiceEventInput,
} from '@domain/ports/ContractServiceEventRepository';

/**
 * InMemoryContractServiceEventRepository — test seam for ContractServiceEventRepository (#110).
 *
 * Array-backed, newest-first (createdAt DESC). Injectable `now()` for deterministic
 * ordering in tests.
 */
export class InMemoryContractServiceEventRepository implements ContractServiceEventRepository {
  private readonly store: ContractServiceEvent[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
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

  /** For test assertions: expose all stored events (unfiltered). */
  all(): ContractServiceEvent[] {
    return this.store.map(e => ({ ...e }));
  }
}

function newestFirst(a: ContractServiceEvent, b: ContractServiceEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id > b.id ? -1 : 1;
}
