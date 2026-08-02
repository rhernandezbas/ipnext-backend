import { prisma } from '../../database/prisma';
import type { StoreProduct } from '@domain/entities/storeProduct';
import type {
  StoreProductRepository,
  CreateStoreProductData,
  UpdateStoreProductData,
} from '@domain/ports/StoreProductRepository';

interface StoreProductRow {
  id: string;
  title: string;
  summary: string;
  description: string;
  priceArs: unknown; // Prisma.Decimal
  maxInstallments: number;
  warrantyText: string;
  badge: string | null;
  imageStorageKey: string | null;
  ticketAreaId: string | null;
  active: boolean;
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(row: StoreProductRow): StoreProduct {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    priceArs: Number(row.priceArs),
    maxInstallments: row.maxInstallments,
    warrantyText: row.warrantyText,
    badge: row.badge,
    imageStorageKey: row.imageStorageKey,
    ticketAreaId: row.ticketAreaId,
    active: row.active,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaStoreProductRepository implements StoreProductRepository {
  async create(data: CreateStoreProductData): Promise<StoreProduct> {
    const row = await prisma.storeProduct.create({
      data: {
        title: data.title,
        summary: data.summary,
        description: data.description,
        priceArs: data.priceArs,
        maxInstallments: data.maxInstallments ?? 1,
        warrantyText: data.warrantyText,
        badge: data.badge ?? null,
        ticketAreaId: data.ticketAreaId ?? null,
        active: data.active ?? false,
        sortOrder: data.sortOrder ?? 0,
      },
    });
    return toEntity(row as unknown as StoreProductRow);
  }

  async update(id: string, patch: UpdateStoreProductData): Promise<StoreProduct | null> {
    try {
      const row = await prisma.storeProduct.update({
        where: { id },
        data: {
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.summary !== undefined && { summary: patch.summary }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.priceArs !== undefined && { priceArs: patch.priceArs }),
          ...(patch.maxInstallments !== undefined && { maxInstallments: patch.maxInstallments }),
          ...(patch.warrantyText !== undefined && { warrantyText: patch.warrantyText }),
          ...(patch.badge !== undefined && { badge: patch.badge }),
          ...(patch.imageStorageKey !== undefined && { imageStorageKey: patch.imageStorageKey }),
          ...(patch.ticketAreaId !== undefined && { ticketAreaId: patch.ticketAreaId }),
          ...(patch.active !== undefined && { active: patch.active }),
          ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
          ...(patch.archivedAt !== undefined && { archivedAt: patch.archivedAt }),
        },
      });
      return toEntity(row as unknown as StoreProductRow);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2025') return null;
      throw err;
    }
  }

  async findById(id: string): Promise<StoreProduct | null> {
    const row = await prisma.storeProduct.findUnique({ where: { id } });
    return row ? toEntity(row as unknown as StoreProductRow) : null;
  }

  async list(): Promise<StoreProduct[]> {
    const rows = await prisma.storeProduct.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r) => toEntity(r as unknown as StoreProductRow));
  }

  async listActive(): Promise<StoreProduct[]> {
    const rows = await prisma.storeProduct.findMany({
      where: { active: true, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => toEntity(r as unknown as StoreProductRow));
  }
}
