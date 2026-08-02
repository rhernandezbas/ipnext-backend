import type { StoreProductRepository, UpdateStoreProductData } from '@domain/ports/StoreProductRepository';
import type { StoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { toStoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { StoreProductNotFoundError } from '@domain/errors/storeProduct.errors';

/** UpdateStoreProduct — admin, `PATCH /api/store/products/:id`. Partial
 * update; archivar = `archivedAt: new Date()` (no hay DELETE). */
export class UpdateStoreProduct {
  constructor(private readonly products: StoreProductRepository) {}

  async execute(id: string, patch: UpdateStoreProductData): Promise<StoreProductAdminDto> {
    const updated = await this.products.update(id, patch);
    if (!updated) throw new StoreProductNotFoundError(id);
    return toStoreProductAdminDto(updated);
  }
}
