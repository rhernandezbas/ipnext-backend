import { randomUUID } from 'crypto';
import type { Session } from '@domain/entities/session';
import type {
  SessionRepository,
  CreateSessionInput,
  ListActiveSessionsQuery,
  SessionPage,
} from '@domain/ports/SessionRepository';

type Stored = Session & { __seq: number };

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
      createdAt: now,
    });
  }

  /** Test helper — NOT part of the port. */
  seed(partial: Partial<Session> & { tokenHash: string }): Session {
    const now = new Date().toISOString();
    return this.insert({
      id: partial.id ?? randomUUID(),
      rbacUserId: partial.rbacUserId ?? 'u1',
      actorLogin: partial.actorLogin ?? 'anonymous',
      tokenHash: partial.tokenHash,
      ip: partial.ip ?? null,
      userAgent: partial.userAgent ?? null,
      loginAt: partial.loginAt ?? now,
      lastSeenAt: partial.lastSeenAt ?? now,
      revokedAt: partial.revokedAt ?? null,
      createdAt: partial.createdAt ?? now,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = this.store.find(s => s.tokenHash === tokenHash && s.revokedAt === null);
    return row ? this.clean(row) : null;
  }

  async findById(id: string): Promise<Session | null> {
    const row = this.store.find(s => s.id === id);
    return row ? this.clean(row) : null;
  }

  async listActive(query: ListActiveSessionsQuery): Promise<SessionPage> {
    const { rbacUserId } = query;
    const rows = this.store
      .filter(s => s.revokedAt === null && (rbacUserId === undefined || s.rbacUserId === rbacUserId))
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
    const rows = this.store
      .filter(s => s.revokedAt !== null)
      .sort((a, b) => {
        const ra = a.revokedAt as string;
        const rb = b.revokedAt as string;
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
