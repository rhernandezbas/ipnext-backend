/**
 * AuditEventRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { AuditEvent } from '../entities/audit';

/** Fields needed to persist an event; id + createdAt are assigned by the adapter. */
export type RecordAuditInput = Omit<AuditEvent, 'id' | 'createdAt'>;

/** Filter + pagination for the audit list. `page` is 1-based. */
export interface AuditEventQuery {
  actorId?: string;
  entityType?: string;
  method?: string;
  /** ISO date/datetime lower bound (inclusive), compared against createdAt. */
  from?: string;
  /** ISO date/datetime upper bound (inclusive), compared against createdAt. */
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditEventPage {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditEventRepository {
  /** Persist one audit record. Never throws into the request path (callers swallow). */
  record(input: RecordAuditInput): Promise<AuditEvent>;
  /** Paginated, filtered list ordered by createdAt DESC. */
  list(query: AuditEventQuery): Promise<AuditEventPage>;
}
