/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: `as any` on Prisma client calls (consistent with the other RBAC/audit
 * adapters) — the Dockerfile runs `prisma generate` in the build.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { Session } from '@domain/entities/session';
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
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly db = prisma) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const row = (await (this.db as any).session.create({
      data: {
        rbacUserId: input.rbacUserId,
        actorLogin: input.actorLogin,
        tokenHash: input.tokenHash,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    })) as SessionRow;
    return mapRow(row);
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = (await (this.db as any).session.findFirst({
      where: { tokenHash, revokedAt: null },
    })) as SessionRow | null;
    return row ? mapRow(row) : null;
  }

  async findById(id: string): Promise<Session | null> {
    const row = (await (this.db as any).session.findUnique({ where: { id } })) as SessionRow | null;
    return row ? mapRow(row) : null;
  }

  async listActive(query: ListActiveSessionsQuery): Promise<SessionPage> {
    const where: Record<string, unknown> = { revokedAt: null };
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
}
