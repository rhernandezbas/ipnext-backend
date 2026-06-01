import { randomUUID } from 'crypto';
import type { Session } from '@domain/entities/session';
import { isSessionAlive, ABSOLUTE_TTL_MS } from '@domain/entities/session.policy';
import type {
  SessionRepository,
  CreateSessionInput,
  ListActiveSessionsQuery,
  SessionPage,
} from '@domain/ports/SessionRepository';

type Stored = Session & { __seq: number };

/** Effective "ended" instant for history ordering: revocation if revoked, else expiry. */
function endedAt(s: Session): string {
  return s.revokedAt ?? s.expiresAt ?? s.lastSeenAt;
}

/**
 * InMemorySessionRepository — test seam. `seed` is a test helper (lets a test
 * set explicit id/loginAt/revokedAt for deterministic assertions). NOT part of
 * the port.
 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly store: Stored[] = [];
  private seq = 0;

  async create(input: CreateSessionInput): Promise<Session> {
    const now = new Date().toISOString();
    return this.insert({
      id: randomUUID(),
      rbacUserId: input.rbacUserId,
      actorLogin: input.actorLogin,
      tokenHash: input.tokenHash,
      ip: input.ip,
      userAgent: input.userAgent,
      loginAt: now,
      lastSeenAt: now,
      revokedAt: null,
      // session-expiration: absolute 8h cap from login.
      expiresAt: new Date(Date.parse(now) + ABSOLUTE_TTL_MS).toISOString(),
      createdAt: now,
    });
  }

  /** Test helper — NOT part of the port. */
  seed(partial: Partial<Session> & { tokenHash: string }): Session {
    const now = new Date().toISOString();
    const loginAt = partial.loginAt ?? now;
    return this.insert({
      id: partial.id ?? randomUUID(),
      rbacUserId: partial.rbacUserId ?? 'u1',
      actorLogin: partial.actorLogin ?? 'anonymous',
      tokenHash: partial.tokenHash,
      ip: partial.ip ?? null,
      userAgent: partial.userAgent ?? null,
      loginAt,
      lastSeenAt: partial.lastSeenAt ?? loginAt,
      revokedAt: partial.revokedAt ?? null,
      expiresAt:
        partial.expiresAt !== undefined
          ? partial.expiresAt
          : new Date(Date.parse(loginAt) + ABSOLUTE_TTL_MS).toISOString(),
      createdAt: partial.createdAt ?? now,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = this.store.find(s => s.tokenHash === tokenHash && isSessionAlive(s));
    return row ? this.clean(row) : null;
  }

  async findById(id: string): Promise<Session | null> {
    const row = this.store.find(s => s.id === id);
    return row ? this.clean(row) : null;
  }

  async listActive(query: ListActiveSessionsQuery): Promise<SessionPage> {
    const { rbacUserId } = query;
    const rows = this.store
      .filter(s => isSessionAlive(s) && (rbacUserId === undefined || s.rbacUserId === rbacUserId))
      .sort((a, b) => (a.loginAt === b.loginAt ? b.__seq - a.__seq : a.loginAt < b.loginAt ? 1 : -1));

    const total = rows.length;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? total;
    const start = (page - 1) * pageSize;
    return { items: rows.slice(start, start + pageSize).map(s => this.clean(s)), total, page, pageSize };
  }

  async revoke(id: string): Promise<void> {
    const row = this.store.find(s => s.id === id);
    if (row && row.revokedAt === null) row.revokedAt = new Date().toISOString();
  }

  async revokeAllForUser(rbacUserId: string): Promise<number> {
    let count = 0;
    const now = new Date().toISOString();
    for (const row of this.store) {
      if (row.rbacUserId === rbacUserId && row.revokedAt === null) {
        row.revokedAt = now;
        count++;
      }
    }
    return count;
  }

  async touch(id: string): Promise<void> {
    const row = this.store.find(s => s.id === id);
    if (row) row.lastSeenAt = new Date().toISOString();
  }

  async findRevoked(page: number, pageSize: number): Promise<SessionPage> {
    // session-expiration: "history" = every session that is no longer alive
    // (explicitly revoked OR expired by absolute cap OR idle past inactivity).
    const rows = this.store
      .filter(s => !isSessionAlive(s))
      .sort((a, b) => {
        const ra = endedAt(a);
        const rb = endedAt(b);
        if (ra !== rb) return ra < rb ? 1 : -1;
        return b.__seq - a.__seq;
      });

    const total = rows.length;
    const start = (page - 1) * pageSize;
    return {
      items: rows.slice(start, start + pageSize).map(s => this.clean(s)),
      total,
      page,
      pageSize,
    };
  }

  private insert(s: Session): Session {
    const stored: Stored = { ...s, __seq: this.seq++ };
    this.store.push(stored);
    return this.clean(stored);
  }

  private clean(s: Stored): Session {
    const { __seq: _seq, ...rest } = s;
    void _seq;
    return { ...rest };
  }
}
