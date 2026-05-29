import { randomUUID } from 'crypto';
import type { AuditEvent } from '@domain/entities/audit';
import type {
  AuditEventRepository,
  AuditEventQuery,
  AuditEventPage,
  RecordAuditInput,
} from '@domain/ports/AuditEventRepository';

type StoredEvent = AuditEvent & { __seq: number };

/**
 * InMemoryAuditEventRepository — test seam for AuditEventRepository.
 *
 * `seed` is an extra helper for tests (lets a test set an explicit `createdAt`
 * for deterministic ordering/date-filter assertions). NOT part of the port.
 */
export class InMemoryAuditEventRepository implements AuditEventRepository {
  private readonly store: StoredEvent[] = [];
  private seq = 0;

  async record(input: RecordAuditInput): Promise<AuditEvent> {
    return this.insert({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
  }

  /** Test helper — insert with explicit fields. NOT part of the port. */
  seed(partial: Partial<AuditEvent>): AuditEvent {
    return this.insert({
      id: partial.id ?? randomUUID(),
      actorId: partial.actorId ?? null,
      actorLogin: partial.actorLogin ?? 'anonymous',
      method: partial.method ?? 'POST',
      path: partial.path ?? '/api/x',
      action: partial.action ?? null,
      entityType: partial.entityType ?? null,
      entityId: partial.entityId ?? null,
      beforeJson: partial.beforeJson ?? null,
      afterJson: partial.afterJson ?? null,
      statusCode: partial.statusCode ?? 200,
      errorMessage: partial.errorMessage ?? null,
      ip: partial.ip ?? null,
      createdAt: partial.createdAt ?? new Date().toISOString(),
    });
  }

  async list(query: AuditEventQuery): Promise<AuditEventPage> {
    const { actorId, entityType, method, from, to } = query;

    const filtered = this.store.filter(e =>
      (actorId === undefined || e.actorId === actorId) &&
      (entityType === undefined || e.entityType === entityType) &&
      (method === undefined || e.method === method) &&
      (from === undefined || e.createdAt >= from) &&
      (to === undefined || e.createdAt <= to),
    );

    // createdAt DESC; tie-break by insertion seq DESC (newest first, stable).
    filtered.sort((a, b) =>
      a.createdAt === b.createdAt ? b.__seq - a.__seq : a.createdAt < b.createdAt ? 1 : -1,
    );

    const total = filtered.length;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? total;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize).map(e => this.clean(e));

    return { items, total, page, pageSize };
  }

  private insert(ev: AuditEvent): AuditEvent {
    const stored: StoredEvent = { ...ev, __seq: this.seq++ };
    this.store.push(stored);
    return this.clean(stored);
  }

  private clean(e: StoredEvent): AuditEvent {
    // strip the internal seq before handing the entity out
    const { __seq: _seq, ...rest } = e;
    void _seq;
    return { ...rest };
  }
}
