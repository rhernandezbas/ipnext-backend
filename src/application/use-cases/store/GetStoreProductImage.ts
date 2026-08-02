import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { FileStorage } from '@domain/ports/FileStorage';

export interface StoreProductImageFileResult {
  buffer: Buffer;
  mimeType: string;
}

/**
 * GetStoreProductImage — admin, `GET /api/store/products/:id/image`
 * (`store.read`). Contraparte STAFF de `GetPortalStoreProductImage`: sirve el
 * MISMO objeto de MinIO, pero SIN el re-chequeo de elegibilidad
 * (active/archivedAt) — mismo criterio que `GetStoreProductAdmin` vs.
 * `GetPortalStoreProduct`: el panel necesita poder mostrar el thumbnail de
 * un producto en borrador o archivado mientras lo edita, no solo de los
 * visibles al cliente.
 *
 * `null` para: producto inexistente, sin imagen, o key sin contenido en
 * storage — 404 indistinguible en la ruta.
 */
export class GetStoreProductImage {
  constructor(
    private readonly products: Pick<StoreProductRepository, 'findById'>,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(productId: string): Promise<StoreProductImageFileResult | null> {
    const product = await this.products.findById(productId);
    if (!product || !product.imageStorageKey) return null;

    const stored = await this.fileStorage.get(product.imageStorageKey);
    if (!stored) return null;
    return { buffer: stored.buffer, mimeType: stored.mimeType };
  }
}
