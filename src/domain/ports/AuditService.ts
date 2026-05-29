/**
 * AuditService — domain port for use-case-level audit enrichment.
 *
 * Use cases that know the true prior state of an entity call `emit` to record
 * a faithful before/after (richer than what the generic mutation middleware can
 * capture from the request/response alone). The infrastructure provides a
 * request-scoped implementation that also dedupes against the generic middleware.
 */
export interface AuditEmitInput {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditService {
  emit(input: AuditEmitInput): Promise<void>;
}
