/**
 * SessionRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { Session } from '../entities/session';

export interface CreateSessionInput {
  rbacUserId: string;
  actorLogin: string;
  tokenHash: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Session-expiration: shared liveness predicate re-exported here so adapters can
 * reference the same policy the use cases use. Defined in the entity layer.
 */
export { isSessionAlive, INACTIVITY_TTL_MS, ABSOLUTE_TTL_MS } from '../entities/session.policy';

export interface ListActiveSessionsQuery {
  rbacUserId?: string;
  page?: number;
  pageSize?: number;
}

export interface SessionPage {
  items: Session[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SessionRepository {
  create(input: CreateSessionInput): Promise<Session>;
  /** Alive session for a token hash, or null if absent, revoked OR expired. */
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  findById(id: string): Promise<Session | null>;
  /** Alive sessions only (not revoked, not expired, active < 1h), paginated, newest first. */
  listActive(query: ListActiveSessionsQuery): Promise<SessionPage>;
  revoke(id: string): Promise<void>;
  /** Revokes every active session of a user; returns how many were revoked. */
  revokeAllForUser(rbacUserId: string): Promise<number>;
  /** Updates lastSeenAt (callers apply throttling). */
  touch(id: string): Promise<void>;
  /** Inactive sessions (revoked OR expired OR idle > 1h), paginated, most-recently-ended first. */
  findRevoked(page: number, pageSize: number): Promise<SessionPage>;
}
