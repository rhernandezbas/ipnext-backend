import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { StoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { toStoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { StoreProductNotFoundError } from '@domain/errors/storeProduct.errors';

/** GetStoreProductAdmin — admin, `GET /api/store/products/:id`. Sin
 * re-chequeo de elegibilidad (a diferencia del portal) — el admin puede ver
 * cualquier producto, incluido uno en borrador o archivado. */
export class GetStoreProductAdmin {
  constructor(private readonly products: Pick<StoreProductRepository, 'findById'>) {}

  async execute(id: string): Promise<StoreProductAdminDto> {
    const product = await this.products.findById(id);
    if (!product) throw new StoreProductNotFoundError(id);
    return toStoreProductAdminDto(product);
  }
}
