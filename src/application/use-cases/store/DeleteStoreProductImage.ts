import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import { StoreProductNotFoundError } from '@domain/errors/storeProduct.errors';

/**
 * DeleteStoreProductImage — admin, `DELETE /api/store/products/:id/image`.
 * Idempotente por diseño respecto de la IMAGEN en sí (borrar una key
 * inexistente en `FileStorage` no es error, ver el port) — pero el PRODUCTO sí
 * debe existir (mismo criterio 404 que el resto del CRUD admin).
 */
export class DeleteStoreProductImage {
  constructor(
    private readonly products: StoreProductRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(productId: string): Promise<void> {
    const product = await this.products.findById(productId);
    if (!product) throw new StoreProductNotFoundError(productId);
    if (!product.imageStorageKey) return;

    const oldKey = product.imageStorageKey;
    await this.products.update(productId, { imageStorageKey: null });
    await this.fileStorage.delete(oldKey);
  }
}
