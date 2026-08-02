import type { StoreProduct } from '@domain/entities/storeProduct';

export interface CreateStoreProductData {
  title: string;
  summary: string;
  description: string;
  priceArs: number;
  /** Ausente = 1 (solo un pago). */
  maxInstallments?: number;
  warrantyText: string;
  badge?: string | null;
  ticketAreaId?: string | null;
  /** Ausente = false (borrador, lado seguro). */
  active?: boolean;
  /** Ausente = 0. */
  sortOrder?: number;
}

/**
 * Partial update — SOLO las keys presentes cambian. `undefined` = no tocar,
 * `null`/valor = setear (mismo contrato que `UpdatePortalPromoData`).
 * `imageStorageKey`/`archivedAt` viven acá para que `UploadStoreProductImage`/
 * `DeleteStoreProductImage`/archivar reusen el mismo `update` — nunca un
 * método de repo paralelo por campo.
 */
export interface UpdateStoreProductData {
  title?: string;
  summary?: string;
  description?: string;
  priceArs?: number;
  maxInstallments?: number;
  warrantyText?: string;
  badge?: string | null;
  imageStorageKey?: string | null;
  ticketAreaId?: string | null;
  active?: boolean;
  sortOrder?: number;
  archivedAt?: Date | null;
}

export interface StoreProductRepository {
  create(data: CreateStoreProductData): Promise<StoreProduct>;
  update(id: string, patch: UpdateStoreProductData): Promise<StoreProduct | null>;
  findById(id: string): Promise<StoreProduct | null>;
  /** Admin — TODOS los productos (borrador/publicado/archivado). */
  list(): Promise<StoreProduct[]>;
  /**
   * Portal — SOLO `active=true` y `archivedAt=null`, ordenado por
   * `sortOrder` asc (empata por `createdAt` desc, el más nuevo primero entre
   * empates). El caller (`ListPortalStoreProducts`) no vuelve a filtrar nada:
   * a diferencia de portal-promos no hay segmentación por cliente acá.
   */
  listActive(): Promise<StoreProduct[]>;
}
