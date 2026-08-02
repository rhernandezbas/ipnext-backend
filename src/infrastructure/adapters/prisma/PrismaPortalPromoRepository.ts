import { prisma } from '../../database/prisma';
import type { PortalPromo } from '@domain/entities/portalPromo';
import type { CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type {
  PortalPromoRepository,
  CreatePortalPromoData,
  UpdatePortalPromoData,
} from '@domain/ports/PortalPromoRepository';

interface PortalPromoRow {
  id: string;
  title: string;
  summary: string;
  body: string;
  imageStorageKey: string | null;
  ctaLabel: string;
  ticketAreaId: string | null;
  segment: unknown;
  startsAt: Date;
  endsAt: Date;
  publishedAt: Date | null;
  archivedAt: Date | null;
  authorId: string | null;
  authorName: string;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(row: PortalPromoRow): PortalPromo {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    body: row.body,
    imageStorageKey: row.imageStorageKey,
    ctaLabel: row.ctaLabel,
    ticketAreaId: row.ticketAreaId,
    segment: (row.segment ?? { statuses: [] }) as CampaignSegmentFilter,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    authorId: row.authorId,
    authorName: row.authorName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaPortalPromoRepository implements PortalPromoRepository {
  async create(data: CreatePortalPromoData): Promise<PortalPromo> {
    const row = await prisma.portalPromo.create({
      data: {
        title: data.title,
        summary: data.summary,
        body: data.body,
        imageStorageKey: data.imageStorageKey ?? null,
        ctaLabel: data.ctaLabel ?? 'Me interesa',
        ticketAreaId: data.ticketAreaId ?? null,
        segment: data.segment as never,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        publishedAt: data.publishedAt ?? null,
        authorId: data.authorId,
        authorName: data.authorName,
      },
    });
    return toEntity(row as unknown as PortalPromoRow);
  }

  async update(id: string, patch: UpdatePortalPromoData): Promise<PortalPromo | null> {
    try {
      const row = await prisma.portalPromo.update({
        where: { id },
        data: {
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.summary !== undefined && { summary: patch.summary }),
          ...(patch.body !== undefined && { body: patch.body }),
          ...(patch.imageStorageKey !== undefined && { imageStorageKey: patch.imageStorageKey }),
          ...(patch.ctaLabel !== undefined && { ctaLabel: patch.ctaLabel }),
          ...(patch.ticketAreaId !== undefined && { ticketAreaId: patch.ticketAreaId }),
          ...(patch.segment !== undefined && { segment: patch.segment as never }),
          ...(patch.startsAt !== undefined && { startsAt: patch.startsAt }),
          ...(patch.endsAt !== undefined && { endsAt: patch.endsAt }),
          ...(patch.publishedAt !== undefined && { publishedAt: patch.publishedAt }),
          ...(patch.archivedAt !== undefined && { archivedAt: patch.archivedAt }),
        },
      });
      return toEntity(row as unknown as PortalPromoRow);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2025') return null;
      throw err;
    }
  }

  async findById(id: string): Promise<PortalPromo | null> {
    const row = await prisma.portalPromo.findUnique({ where: { id } });
    return row ? toEntity(row as unknown as PortalPromoRow) : null;
  }

  async list(): Promise<PortalPromo[]> {
    const rows = await prisma.portalPromo.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r) => toEntity(r as unknown as PortalPromoRow));
  }

  async listActive(now: Date): Promise<PortalPromo[]> {
    const rows = await prisma.portalPromo.findMany({
      where: {
        publishedAt: { not: null },
        archivedAt: null,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { publishedAt: 'desc' },
    });
    return rows.map((r) => toEntity(r as unknown as PortalPromoRow));
  }
}
