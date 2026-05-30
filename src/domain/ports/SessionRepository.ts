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
  /** Active session for a token hash, or null if absent OR revoked. */
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  findById(id: string): Promise<Session | null>;
  /** Active sessions only (revokedAt = null), paginated, newest first. */
  listActive(query: ListActiveSessionsQuery): Promise<SessionPage>;
  revoke(id: string): Promise<void>;
  /** Revokes every active session of a user; returns how many were revoked. */
  revokeAllForUser(rbacUserId: string): Promise<number>;
  /** Updates lastSeenAt (callers apply throttling). */
  touch(id: string): Promise<void>;
}
