import { randomUUID } from 'crypto';
import type { PortalNotification } from '@domain/entities/portalNotification';
import type {
  PortalNotificationRepository,
  CreatePortalNotificationInput,
} from '@domain/ports/PortalNotificationRepository';
import type { PaginatedResult, PaginatedQuery } from '@domain/entities/pagination';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;

/** InMemoryPortalNotificationRepository — test seam (portal-notification-inbox). */
export class InMemoryPortalNotificationRepository implements PortalNotificationRepository {
  private readonly store: PortalNotification[] = [];

  async create(input: CreatePortalNotificationInput): Promise<PortalNotification> {
    const row: PortalNotification = {
      id: randomUUID(),
      accountId: input.accountId,
      channel: input.channel,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      sentAt: new Date().toISOString(),
      readAt: null,
    };
    this.store.push(row);
    return { ...row };
  }

  async listForAccount(accountId: string, query: PaginatedQuery): Promise<PaginatedResult<PortalNotification>> {
    const page = query.page && query.page >= 1 ? query.page : DEFAULT_PAGE;
    const limit = query.limit && query.limit >= 1 ? query.limit : DEFAULT_LIMIT;

    const all = this.store
      .filter((n) => n.accountId === accountId)
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));

    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit).map((n) => ({ ...n }));

    return { data, total: all.length, page, limit };
  }

  async countUnread(accountId: string): Promise<number> {
    return this.store.filter((n) => n.accountId === accountId && n.readAt === null).length;
  }

  async markRead(accountId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const now = new Date().toISOString();
    for (const row of this.store) {
      if (row.accountId === accountId && idSet.has(row.id)) row.readAt = now;
    }
  }

  async markAllRead(accountId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const row of this.store) {
      if (row.accountId === accountId && row.readAt === null) row.readAt = now;
    }
  }

  /** Test seam — lee el estado crudo de una fila (para asserts). */
  findById(id: string): PortalNotification | undefined {
    const row = this.store.find((n) => n.id === id);
    return row ? { ...row } : undefined;
  }
}
