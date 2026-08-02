import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import { isStoreProductVisible } from './storeProductEligibility';

export interface PortalStoreProductImageFile {
  buffer: Buffer;
  mimeType: string;
}

/**
 * GetPortalStoreProductImage — portal-store, `GET
 * /api/portal/store/products/:id/image`. La rebanada de imagen va COMPLETA:
 * a diferencia de portal-promos (donde esta ruta NUNCA se implementó), acá
 * sirve el binario guardado por `UploadStoreProductImage`. Mismo re-chequeo
 * de elegibilidad que `GetPortalStoreProduct` — un producto en borrador o
 * archivado no debe filtrar su imagen aunque alguien tenga la key/URL vieja.
 * `null` para: producto inexistente/no visible, sin imagen, o key sin
 * contenido en storage — todos 404 indistinguibles en la ruta.
 */
export class GetPortalStoreProductImage {
  constructor(
    private readonly products: Pick<StoreProductRepository, 'findById'>,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(productId: string): Promise<PortalStoreProductImageFile | null> {
    const product = await this.products.findById(productId);
    if (!product || !isStoreProductVisible(product)) return null;
    if (!product.imageStorageKey) return null;

    const stored = await this.fileStorage.get(product.imageStorageKey);
    if (!stored) return null;
    return { buffer: stored.buffer, mimeType: stored.mimeType };
  }
}
