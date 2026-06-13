import { randomUUID } from 'crypto';
import type {
  TvActivationEvent,
  TvActivationEventRepository,
  RecordTvActivationEventInput,
  ListTvActivationEventsFilter,
} from '@domain/ports/TvActivationEventRepository';

/**
 * InMemoryTvActivationEventRepository — test seam for TvActivationEventRepository.
 *
 * Array-backed, newest-first (createdAt DESC). Injectable `now()` for deterministic
 * ordering in tests.
 */
export class InMemoryTvActivationEventRepository implements TvActivationEventRepository {
  private readonly store: TvActivationEvent[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async record(input: RecordTvActivationEventInput): Promise<TvActivationEvent> {
    const event: TvActivationEvent = {
      id: randomUUID(),
      clientId: input.clientId,
      actorId: input.actorId,
      actorName: input.actorName,
      eventType: input.eventType,
      cic: input.cic ?? null,
      internalId: input.internalId ?? null,
      seq: input.seq ?? null,
      contractId: input.contractId ?? null,
      createdAt: this.now().toISOString(),
    };
    this.store.push(event);
    return { ...event };
  }

  async listByClient(clientId: string): Promise<TvActivationEvent[]> {
    return this.store
      .filter(e => e.clientId === clientId)
      .sort(newestFirst)
      .map(e => ({ ...e }));
  }

  async list(filters: ListTvActivationEventsFilter): Promise<TvActivationEvent[]> {
    return this.store
      .filter(e => {
        if (filters.clientId && e.clientId !== filters.clientId) return false;
        if (filters.actorId && e.actorId !== filters.actorId) return false;
        if (filters.from && new Date(e.createdAt) < filters.from) return false;
        if (filters.to && new Date(e.createdAt) > filters.to) return false;
        return true;
      })
      .sort(newestFirst)
      .map(e => ({ ...e }));
  }

  /** For test assertions: expose all stored events (unfiltered). */
  all(): TvActivationEvent[] {
    return this.store.map(e => ({ ...e }));
  }
}

function newestFirst(a: TvActivationEvent, b: TvActivationEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id > b.id ? -1 : 1;
}
