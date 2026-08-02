import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { StoreProductSummaryDto } from '@application/dto/portal/storeProduct.dto';
import { toStoreProductSummaryDto } from '@application/dto/portal/storeProduct.dto';

/**
 * ListPortalStoreProducts — portal-store, `GET /api/portal/store/products`.
 * Sin segmentación (a diferencia de portal-promos): todo cliente logueado ve
 * el mismo catálogo. `listActive` ya filtra `active`/`archivedAt` y ordena en
 * el repo (sortOrder asc, createdAt desc como desempate) — nada que reordenar
 * acá.
 */
export class ListPortalStoreProducts {
  constructor(private readonly products: Pick<StoreProductRepository, 'listActive'>) {}

  async execute(): Promise<StoreProductSummaryDto[]> {
    const active = await this.products.listActive();
    return active.map(toStoreProductSummaryDto);
  }
}
