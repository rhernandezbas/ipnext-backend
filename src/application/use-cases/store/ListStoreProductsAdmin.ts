import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { StoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { toStoreProductAdminDto } from '@application/dto/storeProducts.dto';

/** ListStoreProductsAdmin — admin, `GET /api/store/products`. TODOS los
 * productos (borrador/publicado/archivado) — a diferencia del listado
 * client-facing, que solo muestra los activos y no archivados. */
export class ListStoreProductsAdmin {
  constructor(private readonly products: Pick<StoreProductRepository, 'list'>) {}

  async execute(): Promise<StoreProductAdminDto[]> {
    const all = await this.products.list();
    return all.map(toStoreProductAdminDto);
  }
}
