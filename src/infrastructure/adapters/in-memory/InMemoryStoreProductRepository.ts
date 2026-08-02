import { randomUUID } from 'crypto';
import type { StoreProduct } from '@domain/entities/storeProduct';
import type {
  StoreProductRepository,
  CreateStoreProductData,
  UpdateStoreProductData,
} from '@domain/ports/StoreProductRepository';

export class InMemoryStoreProductRepository implements StoreProductRepository {
  private readonly store: StoreProduct[] = [];

  async create(data: CreateStoreProductData): Promise<StoreProduct> {
    const now = new Date().toISOString();
    const product: StoreProduct = {
      id: randomUUID(),
      title: data.title,
      summary: data.summary,
      description: data.description,
      priceArs: data.priceArs,
      maxInstallments: data.maxInstallments ?? 1,
      warrantyText: data.warrantyText,
      badge: data.badge ?? null,
      imageStorageKey: null,
      ticketAreaId: data.ticketAreaId ?? null,
      active: data.active ?? false,
      sortOrder: data.sortOrder ?? 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.push(product);
    return { ...product };
  }

  async update(id: string, patch: UpdateStoreProductData): Promise<StoreProduct | null> {
    const idx = this.store.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const current = this.store[idx]!;
    const updated: StoreProduct = {
      ...current,
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
      ...(patch.archivedAt !== undefined && { archivedAt: patch.archivedAt ? patch.archivedAt.toISOString() : null }),
      updatedAt: new Date().toISOString(),
    };
    this.store[idx] = updated;
    return { ...updated };
  }

  async findById(id: string): Promise<StoreProduct | null> {
    const row = this.store.find((p) => p.id === id);
    return row ? { ...row } : null;
  }

  async list(): Promise<StoreProduct[]> {
    return [...this.store]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((p) => ({ ...p }));
  }

  async listActive(): Promise<StoreProduct[]> {
    return this.store
      .filter((p) => p.active && p.archivedAt === null)
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.createdAt < b.createdAt ? 1 : -1;
      })
      .map((p) => ({ ...p }));
  }
}
