import { MaterialStock } from '@domain/entities/material-stock';

export interface MaterialStockRepository {
  findByMaterialAndLocation(
    materialCatalogId: string,
    locationId: string,
  ): Promise<MaterialStock | null>;
  /** All material stock rows at a location. */
  listByLocation(locationId: string): Promise<MaterialStock[]>;
  /** Find-or-create the (materialCatalogId, locationId) row, setting qty. */
  upsert(stock: MaterialStock): Promise<MaterialStock>;
  /** Decrement qty; throws InsufficientStockError if the result would be negative. */
  decrement(materialCatalogId: string, locationId: string, amount: number): Promise<MaterialStock>;
  /** Increment qty; creates the row at 0 first if it does not exist. */
  increment(materialCatalogId: string, locationId: string, amount: number): Promise<MaterialStock>;
}
