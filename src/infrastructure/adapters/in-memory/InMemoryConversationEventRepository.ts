import { randomUUID } from 'crypto';
import {
  ConversationEventRepository,
  ConversationEventRecord,
  RecordConversationEventInput,
  ResolutionsByDay,
  ConversationEventType,
} from '@domain/ports/ConversationEventRepository';
import { toArgentinaDateKey } from '@application/use-cases/messaging/reportsTimezone';

/**
 * In-memory ConversationEventRepository for use-case and route tests. MUST mirror
 * `PrismaConversationEventRepository`'s semantics: range `[from,to)` semi-open on `createdAt`,
 * day-bucketing en zona AR (UTC-3 fijo, `toArgentinaDateKey`).
 */
export class InMemoryConversationEventRepository implements ConversationEventRepository {
  // `seq` = orden de inserción monotónico. Tiebreak DETERMINISTA de `listByConversation`
  // cuando dos eventos comparten el mismo `createdAt` al milisegundo (append-only → el orden
  // de inserción ES el orden cronológico real; el id UUID no lo refleja). En el adapter Prisma
  // el tiebreak por `id` es arbitrario-pero-estable para eventos del MISMO instante (aceptable:
  // están al mismo instante; en prod dos transiciones de estado nunca comparten ms).
  private rows: Array<ConversationEventRecord & { seq: number }> = [];
  private seqCounter = 0;

  /**
   * Test hook — cuando es `true`, `record` lanza. Sirve para probar el best-effort del
   * caller (un fallo al registrar el evento NO debe tumbar el resolve/assign/creación).
   */
  failRecord = false;

  async record(input: RecordConversationEventInput): Promise<ConversationEventRecord> {
    if (this.failRecord) throw new Error('InMemoryConversationEventRepository.record forced failure');
    const row: ConversationEventRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      type: input.type,
      actorId: input.actorId ?? null,
      fromValue: input.fromValue ?? null,
      toValue: input.toValue ?? null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push({ ...row, seq: ++this.seqCounter });
    return { ...row };
  }

  /**
   * Test helper — inserta un evento con `createdAt` EXPLÍCITO (el port `record` siempre usa
   * "ahora"). Necesario para los tests de agregación por rango/día, que necesitan controlar
   * el timestamp. No es parte del port.
   */
  seed(events: Array<{ conversationId: string; type: ConversationEventType; createdAt: string; actorId?: string | null; fromValue?: string | null; toValue?: string | null }>): void {
    for (const e of events) {
      this.rows.push({
        id: randomUUID(),
        conversationId: e.conversationId,
        type: e.type,
        actorId: e.actorId ?? null,
        fromValue: e.fromValue ?? null,
        toValue: e.toValue ?? null,
        createdAt: e.createdAt,
        seq: ++this.seqCounter,
      });
    }
  }

  private inRange(iso: string, fromIso: string, toIso: string): boolean {
    const t = new Date(iso).getTime();
    return t >= new Date(fromIso).getTime() && t < new Date(toIso).getTime();
  }

  async countByTypeBetween(type: ConversationEventType, fromIso: string, toIso: string): Promise<number> {
    return this.rows.filter((r) => r.type === type && this.inRange(r.createdAt, fromIso, toIso)).length;
  }

  async resolvedCountByDay(fromIso: string, toIso: string): Promise<ResolutionsByDay[]> {
    const counts = new Map<string, number>();
    for (const r of this.rows) {
      if (r.type !== 'resolved') continue;
      if (!this.inRange(r.createdAt, fromIso, toIso)) continue;
      const key = toArgentinaDateKey(r.createdAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  async listByConversation(conversationId: string): Promise<ConversationEventRecord[]> {
    return this.rows
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => {
        const byDate = a.createdAt.localeCompare(b.createdAt);
        if (byDate !== 0) return byDate;
        return a.seq - b.seq; // tiebreak por orden de inserción (cronológico real)
      })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ seq, ...rec }) => rec);
  }
}
