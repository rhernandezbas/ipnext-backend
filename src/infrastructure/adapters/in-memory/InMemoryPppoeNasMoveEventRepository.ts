import { randomUUID } from 'crypto';
import type {
  ListPppoeNasMoveEventsParams,
  PppoeNasMoveEvent,
  PppoeNasMoveEventRepository,
  RecordPppoeNasMoveEventInput,
} from '@domain/ports/PppoeNasMoveEventRepository';

/**
 * InMemoryPppoeNasMoveEventRepository — test seam para PppoeNasMoveEventRepository
 * (pppoe-move-nas W1). Array-backed, newest-first (createdAt DESC, id DESC como desempate).
 * `now()` inyectable para orden determinístico en tests.
 */
export class InMemoryPppoeNasMoveEventRepository implements PppoeNasMoveEventRepository {
  private readonly store: PppoeNasMoveEvent[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async record(input: RecordPppoeNasMoveEventInput): Promise<PppoeNasMoveEvent> {
    const event: PppoeNasMoveEvent = {
      id:             randomUUID(),
      username:       input.username,
      pppoeServiceId: input.pppoeServiceId ?? null,
      fromNasId:      input.fromNasId ?? null,
      toNasId:        input.toNasId ?? null,
      fromIp:         input.fromIp ?? null,
      toIp:           input.toIp ?? null,
      trigger:        input.trigger,
      outcome:        input.outcome,
      reason:         input.reason ?? null,
      actorName:      input.actorName ?? null,
      createdAt:      this.now().toISOString(),
    };
    this.store.push(event);
    return { ...event };
  }

  async list(params: ListPppoeNasMoveEventsParams): Promise<{ items: PppoeNasMoveEvent[]; total: number }> {
    const usernameLower = params.username?.toLowerCase();
    const filtered = this.store.filter(e => {
      if (params.outcome && e.outcome !== params.outcome) return false;
      if (params.trigger && e.trigger !== params.trigger) return false;
      // usernameExact (D-W2.5 item 7): igualdad EXACTA (throttle/cooldown del watcher) —
      // espejo del adapter Prisma: si vienen ambos filtros, exact gana.
      if (params.usernameExact) {
        if (e.username !== params.usernameExact) return false;
      } else if (usernameLower && !e.username.toLowerCase().includes(usernameLower)) {
        return false;
      }
      return true;
    });

    const sorted = [...filtered].sort(newestFirst);
    const total = sorted.length;
    const skip = (params.page - 1) * params.limit;
    const items = sorted.slice(skip, skip + params.limit).map(e => ({ ...e }));
    return { items, total };
  }

  /** For test assertions: expose all stored events (unfiltered, insertion order). */
  all(): PppoeNasMoveEvent[] {
    return this.store.map(e => ({ ...e }));
  }
}

function newestFirst(a: PppoeNasMoveEvent, b: PppoeNasMoveEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id > b.id ? -1 : 1;
}
