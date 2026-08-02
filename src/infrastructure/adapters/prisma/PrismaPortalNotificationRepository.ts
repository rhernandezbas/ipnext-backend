import { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma';
import type { PortalNotification } from '@domain/entities/portalNotification';
import type {
  PortalNotificationRepository,
  CreatePortalNotificationInput,
} from '@domain/ports/PortalNotificationRepository';
import type { PaginatedResult, PaginatedQuery } from '@domain/entities/pagination';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;

interface PortalNotificationRow {
  id: string;
  accountId: string;
  channel: string;
  title: string;
  body: string;
  data: unknown;
  sentAt: Date;
  readAt: Date | null;
}

function toEntity(row: PortalNotificationRow): PortalNotification {
  return {
    id: row.id,
    accountId: row.accountId,
    channel: row.channel === 'promo' ? 'promo' : 'service',
    title: row.title,
    body: row.body,
    data: (row.data as Record<string, unknown> | null) ?? null,
    sentAt: row.sentAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

function toJson(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === undefined || value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/** PrismaPortalNotificationRepository — portal-notification-inbox, Postgres-backed. */
export class PrismaPortalNotificationRepository implements PortalNotificationRepository {
  async create(input: CreatePortalNotificationInput): Promise<PortalNotification> {
    const row = await prisma.portalNotification.create({
      data: {
        accountId: input.accountId,
        channel: input.channel,
        title: input.title,
        body: input.body,
        data: toJson(input.data),
      },
    });
    return toEntity(row as unknown as PortalNotificationRow);
  }

  async listForAccount(accountId: string, query: PaginatedQuery): Promise<PaginatedResult<PortalNotification>> {
    const page = query.page && query.page >= 1 ? query.page : DEFAULT_PAGE;
    const limit = query.limit && query.limit >= 1 ? query.limit : DEFAULT_LIMIT;

    const [rows, total] = await Promise.all([
      prisma.portalNotification.findMany({
        where: { accountId },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.portalNotification.count({ where: { accountId } }),
    ]);

    return { data: rows.map((r) => toEntity(r as unknown as PortalNotificationRow)), total, page, limit };
  }

  async countUnread(accountId: string): Promise<number> {
    return prisma.portalNotification.count({ where: { accountId, readAt: null } });
  }

  /** `updateMany` con AMBAS condiciones (accountId + id IN ids) — cero riesgo de tocar la fila de otra cuenta. */
  async markRead(accountId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await prisma.portalNotification.updateMany({
      where: { accountId, id: { in: ids } },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(accountId: string): Promise<void> {
    await prisma.portalNotification.updateMany({
      where: { accountId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
