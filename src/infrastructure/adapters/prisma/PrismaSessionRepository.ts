/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: `as any` on Prisma client calls (consistent with the other RBAC/audit
 * adapters) — the Dockerfile runs `prisma generate` in the build.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { Session } from '@domain/entities/session';
import { INACTIVITY_TTL_MS, ABSOLUTE_TTL_MS } from '@domain/entities/session.policy';
import type {
  SessionRepository,
  CreateSessionInput,
  ListActiveSessionsQuery,
  SessionPage,
} from '@domain/ports/SessionRepository';

type SessionRow = {
  id: string;
  rbacUserId: string;
  actorLogin: string;
  tokenHash: string;
  ip: string | null;
  userAgent: string | null;
  loginAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
};

function mapRow(row: SessionRow): Session {
  return {
    id: row.id,
    rbacUserId: row.rbacUserId,
    actorLogin: row.actorLogin,
    tokenHash: row.tokenHash,
    ip: row.ip,
    userAgent: row.userAgent,
    loginAt: row.loginAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * session-expiration: the same "alive" predicate as `isSessionAlive`, expressed
 * as a Prisma `where` fragment so the DB does the filtering. A session is alive
 * when not revoked AND not past its absolute cap AND seen within the last hour.
 */
function aliveWhere(now: Date): Record<string, unknown> {
  return {
    revokedAt: null,
    expiresAt: { gt: now },
    lastSeenAt: { gt: new Date(now.getTime() - INACTIVITY_TTL_MS) },
  };
}

/** Complement of `aliveWhere`: revoked OR expired OR idle past inactivity. */
function inactiveWhere(now: Date): Record<string, unknown> {
  return {
    OR: [
      { revokedAt: { not: null } },
      { expiresAt: { lte: now } },
      { lastSeenAt: { lte: new Date(now.getTime() - INACTIVITY_TTL_MS) } },
    ],
  };
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly db = prisma) {}

  async create(input: CreateSessionInput): Promise<Session> {
    // session-expiration: pin loginAt and derive the absolute 8h expiry from it
    // so expiresAt == loginAt + 8h exactly (no clock drift vs the DB default).
    const loginAt = new Date();
    const expiresAt = new Date(loginAt.getTime() + ABSOLUTE_TTL_MS);
    const row = (await (this.db as any).session.create({
      data: {
        rbacUserId: input.rbacUserId,
        actorLogin: input.actorLogin,
        tokenHash: input.tokenHash,
        ip: input.ip,
        userAgent: input.userAgent,
        loginAt,
        lastSeenAt: loginAt,
        expiresAt,
      },
    })) as SessionRow;
    return mapRow(row);
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = (await (this.db as any).session.findFirst({
      where: { tokenHash, ...aliveWhere(new Date()) },
    })) as SessionRow | null;
    return row ? mapRow(row) : null;
  }

  async findById(id: string): Promise<Session | null> {
    const row = (await (this.db as any).session.findUnique({ where: { id } })) as SessionRow | null;
    return row ? mapRow(row) : null;
  }

  async listActive(query: ListActiveSessionsQuery): Promise<SessionPage> {
    const where: Record<string, unknown> = { ...aliveWhere(new Date()) };
    if (query.rbacUserId) where['rbacUserId'] = query.rbacUserId;

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const [rows, total] = await Promise.all([
      (this.db as any).session.findMany({
        where,
        orderBy: { loginAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }) as Promise<SessionRow[]>,
      (this.db as any).session.count({ where }) as Promise<number>,
    ]);

    return { items: rows.map(mapRow), total, page, pageSize };
  }

  async revoke(id: string): Promise<void> {
    await (this.db as any).session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(rbacUserId: string): Promise<number> {
    const result = (await (this.db as any).session.updateMany({
      where: { rbacUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    })) as { count: number };
    return result.count;
  }

  async touch(id: string): Promise<void> {
    await (this.db as any).session.update({
      where: { id },
      data: { lastSeenAt: new Date() },
    });
  }

  async findRevoked(page: number, pageSize: number): Promise<SessionPage> {
    // session-expiration: history = inactive sessions (revoked OR expired OR idle).
    // Ordered by expiry DESC as a stable "most recently ended first" proxy.
    const where = inactiveWhere(new Date());

    const [rows, total] = await Promise.all([
      (this.db as any).session.findMany({
        where,
        orderBy: { expiresAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }) as Promise<SessionRow[]>,
      (this.db as any).session.count({ where }) as Promise<number>,
    ]);

    return { items: rows.map(mapRow), total, page, pageSize };
  }
}
