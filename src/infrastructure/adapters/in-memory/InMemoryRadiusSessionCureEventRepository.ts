import { randomUUID } from 'crypto';
import type {
  ListRadiusSessionCureEventsParams,
  RadiusSessionCureEvent,
  RadiusSessionCureEventRepository,
  RecordRadiusSessionCureEventInput,
} from '@domain/ports/RadiusSessionCureEventRepository';

/**
 * InMemoryRadiusSessionCureEventRepository — test seam para RadiusSessionCureEventRepository
 * (radius-session-autocure BE-1). Array-backed, newest-first (createdAt DESC, id DESC como
 * desempate). `now()` inyectable para orden determinístico en tests. Molde
 * InMemoryPppoeNasMoveEventRepository + filtros from/to de InMemoryRadiusAuthEventRepository.
 */
export class InMemoryRadiusSessionCureEventRepository implements RadiusSessionCureEventRepository {
  private readonly store: RadiusSessionCureEvent[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async record(input: RecordRadiusSessionCureEventInput): Promise<RadiusSessionCureEvent> {
    const event: RadiusSessionCureEvent = {
      id:                randomUUID(),
      username:          input.username,
      nasIp:             input.nasIp ?? null,
      sessionId:         input.sessionId ?? null,
      sessionStartedAt:  input.sessionStartedAt ?? null,
      sessionLastUpdate: input.sessionLastUpdate ?? null,
      signalUsed:        input.signalUsed ?? null,
      trigger:           input.trigger,
      action:            input.action ?? null,
      outcome:           input.outcome,
      reason:            input.reason ?? null,
      actorName:         input.actorName ?? null,
      createdAt:         this.now().toISOString(),
    };
    this.store.push(event);
    return { ...event };
  }

  async list(params: ListRadiusSessionCureEventsParams): Promise<{ items: RadiusSessionCureEvent[]; total: number }> {
    const filtered = this.filterBase(params);
    const withOutcome = params.outcome ? filtered.filter(e => e.outcome === params.outcome) : filtered;

    const sorted = [...withOutcome].sort(newestFirst);
    const total = sorted.length;
    const skip = (params.page - 1) * params.limit;
    const items = sorted.slice(skip, skip + params.limit).map(e => ({ ...e }));
    return { items, total };
  }

  async countByOutcome(filters: { username?: string; trigger?: string; from?: Date; to?: Date }): Promise<Record<string, number>> {
    const filtered = this.filterBase(filters);
    const counts: Record<string, number> = {};
    for (const e of filtered) {
      counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
    }
    return counts;
  }

  private filterBase(params: {
    username?: string;
    usernameExact?: string;
    trigger?: string;
    from?: Date;
    to?: Date;
  }): RadiusSessionCureEvent[] {
    const usernameLower = params.username?.toLowerCase();
    return this.store.filter(e => {
      if (params.trigger && e.trigger !== params.trigger) return false;
      // usernameExact gana sobre el contains (molde D-W2.5 item 7 — evita 'perez1' matcheando 'perez10').
      if (params.usernameExact) {
        if (e.username !== params.usernameExact) return false;
      } else if (usernameLower && !e.username.toLowerCase().includes(usernameLower)) {
        return false;
      }
      if (params.from && new Date(e.createdAt).getTime() < params.from.getTime()) return false;
      if (params.to && new Date(e.createdAt).getTime() > params.to.getTime()) return false;
      return true;
    });
  }

  /** For test assertions: expose all stored events (unfiltered, insertion order). */
  all(): RadiusSessionCureEvent[] {
    return this.store.map(e => ({ ...e }));
  }

  /**
   * Test seam: siembra filas YA construidas (con `createdAt` arbitrario), para simular estado
   * histórico (p.ej. curas de hace 20h para el check de flapping ≥3/24h) sin depender del
   * `now()` fijo inyectado en el constructor. NO usar en producción.
   */
  seed(events: Omit<RadiusSessionCureEvent, 'id'>[]): void {
    for (const e of events) this.store.push({ id: randomUUID(), ...e });
  }
}

function newestFirst(a: RadiusSessionCureEvent, b: RadiusSessionCureEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id > b.id ? -1 : 1;
}
