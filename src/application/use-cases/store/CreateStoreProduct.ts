import type { StoreProductRepository, CreateStoreProductData } from '@domain/ports/StoreProductRepository';
import type { StoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { toStoreProductAdminDto } from '@application/dto/storeProducts.dto';

/** CreateStoreProduct — admin, `POST /api/store/products`. Nace SIEMPRE en
 * borrador salvo que `active: true` venga explícito en el body (lado seguro,
 * mismo default `false` que la columna). */
export class CreateStoreProduct {
  constructor(private readonly products: StoreProductRepository) {}

  async execute(input: CreateStoreProductData): Promise<StoreProductAdminDto> {
    const product = await this.products.create(input);
    return toStoreProductAdminDto(product);
  }
}
