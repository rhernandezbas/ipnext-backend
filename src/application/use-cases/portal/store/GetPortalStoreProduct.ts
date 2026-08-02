import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { StoreProductDetailDto } from '@application/dto/portal/storeProduct.dto';
import { toStoreProductDetailDto } from '@application/dto/portal/storeProduct.dto';
import { isStoreProductVisible } from './storeProductEligibility';

/**
 * GetPortalStoreProduct — portal-store, `GET /api/portal/store/products/:id`.
 * Re-chequea elegibilidad SIEMPRE (nunca confía en que el cliente solo pida
 * el id de un producto que vio en la lista): inexistente, borrador o
 * archivado -> `null` (⇒ 404 en la ruta), sin distinguir cuál.
 */
export class GetPortalStoreProduct {
  constructor(private readonly products: Pick<StoreProductRepository, 'findById'>) {}

  async execute(productId: string): Promise<StoreProductDetailDto | null> {
    const product = await this.products.findById(productId);
    if (!product || !isStoreProductVisible(product)) return null;
    return toStoreProductDetailDto(product);
  }
}
