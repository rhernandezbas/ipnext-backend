/**
 * Audit domain entities.
 *
 * Lives in the domain layer — zero external dependencies (no Prisma/Express).
 * `AuditEvent` is an immutable record of a mutation performed against the API.
 */

/**
 * A persisted audit record for a single mutation (POST/PUT/PATCH/DELETE).
 *
 * `actorId` is nullable (the FK is SET NULL on user delete) but `actorLogin`
 * is a snapshot taken at write time, so the record survives the actor's
 * deletion. `beforeJson`/`afterJson` are sensitive-masked JSON projections.
 */
export interface AuditEvent {
  id: string;
  actorId: string | null;
  actorLogin: string;
  method: string;
  path: string;
  action: string | null;
  entityType: string | null;
  entityId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  statusCode: number;
  errorMessage: string | null;
  ip: string | null;
  createdAt: string;
}
