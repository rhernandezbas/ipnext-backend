import { randomUUID } from 'crypto';
import type { PortalPromo } from '@domain/entities/portalPromo';
import type {
  PortalPromoRepository,
  CreatePortalPromoData,
  UpdatePortalPromoData,
} from '@domain/ports/PortalPromoRepository';

export class InMemoryPortalPromoRepository implements PortalPromoRepository {
  private readonly store: PortalPromo[] = [];

  async create(data: CreatePortalPromoData): Promise<PortalPromo> {
    const now = new Date().toISOString();
    const promo: PortalPromo = {
      id: randomUUID(),
      title: data.title,
      summary: data.summary,
      body: data.body,
      imageStorageKey: data.imageStorageKey ?? null,
      ctaLabel: data.ctaLabel ?? 'Me interesa',
      ticketAreaId: data.ticketAreaId ?? null,
      segment: data.segment,
      startsAt: data.startsAt.toISOString(),
      endsAt: data.endsAt.toISOString(),
      publishedAt: data.publishedAt ? data.publishedAt.toISOString() : null,
      archivedAt: null,
      authorId: data.authorId,
      authorName: data.authorName,
      createdAt: now,
      updatedAt: now,
    };
    this.store.push(promo);
    return { ...promo };
  }

  async update(id: string, patch: UpdatePortalPromoData): Promise<PortalPromo | null> {
    const idx = this.store.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const current = this.store[idx]!;
    const updated: PortalPromo = {
      ...current,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.summary !== undefined && { summary: patch.summary }),
      ...(patch.body !== undefined && { body: patch.body }),
      ...(patch.imageStorageKey !== undefined && { imageStorageKey: patch.imageStorageKey }),
      ...(patch.ctaLabel !== undefined && { ctaLabel: patch.ctaLabel }),
      ...(patch.ticketAreaId !== undefined && { ticketAreaId: patch.ticketAreaId }),
      ...(patch.segment !== undefined && { segment: patch.segment }),
      ...(patch.startsAt !== undefined && { startsAt: patch.startsAt.toISOString() }),
      ...(patch.endsAt !== undefined && { endsAt: patch.endsAt.toISOString() }),
      ...(patch.publishedAt !== undefined && { publishedAt: patch.publishedAt ? patch.publishedAt.toISOString() : null }),
      ...(patch.archivedAt !== undefined && { archivedAt: patch.archivedAt ? patch.archivedAt.toISOString() : null }),
      updatedAt: new Date().toISOString(),
    };
    this.store[idx] = updated;
    return { ...updated };
  }

  async findById(id: string): Promise<PortalPromo | null> {
    const row = this.store.find((p) => p.id === id);
    return row ? { ...row } : null;
  }

  async list(): Promise<PortalPromo[]> {
    return [...this.store]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((p) => ({ ...p }));
  }

  async listActive(now: Date): Promise<PortalPromo[]> {
    const nowMs = now.getTime();
    return this.store
      .filter(
        (p) =>
          p.publishedAt !== null &&
          p.archivedAt === null &&
          new Date(p.startsAt).getTime() <= nowMs &&
          new Date(p.endsAt).getTime() >= nowMs,
      )
      .sort((a, b) => (a.publishedAt! < b.publishedAt! ? 1 : -1))
      .map((p) => ({ ...p }));
  }
}
