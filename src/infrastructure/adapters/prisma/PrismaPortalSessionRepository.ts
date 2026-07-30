/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '@infrastructure/database/prisma';
import type { PortalSession } from '@domain/entities/portalSession';
import type {
  PortalSessionRepository,
  CreatePortalSessionInput,
} from '@domain/ports/PortalSessionRepository';

type PortalSessionRow = {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  createdAt: Date;
};

function mapRow(row: PortalSessionRow): PortalSession {
  return {
    id: row.id,
    accountId: row.accountId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaPortalSessionRepository implements PortalSessionRepository {
  constructor(private readonly db = prisma) {}

  async create(input: CreatePortalSessionInput): Promise<PortalSession> {
    const row = (await (this.db as any).portalSession.create({
      data: {
        accountId: input.accountId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    })) as PortalSessionRow;
    return mapRow(row);
  }

  async findByTokenHash(tokenHash: string): Promise<PortalSession | null> {
    const row = (await (this.db as any).portalSession.findUnique({ where: { tokenHash } })) as PortalSessionRow | null;
    return row ? mapRow(row) : null;
  }

  async markRotated(id: string): Promise<void> {
    await (this.db as any).portalSession.updateMany({
      where: { id, rotatedAt: null },
      data: { rotatedAt: new Date() },
    });
  }

  async revoke(id: string): Promise<void> {
    await (this.db as any).portalSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForAccount(accountId: string): Promise<number> {
    const result = (await (this.db as any).portalSession.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date() },
    })) as { count: number };
    return result.count;
  }
}
