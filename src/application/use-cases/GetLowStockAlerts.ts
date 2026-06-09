import { MaterialCatalogRepository, LowStockAlertDTO } from '@domain/ports/MaterialCatalogRepository';

/**
 * Wave 7 (Capstone) — GET /api/inventory/alerts.
 *
 * Returns materials where minStock > 0 AND SUM(MaterialStock.qty) < minStock.
 * Delegates entirely to MaterialCatalogRepository.listLowStock() — the adapter
 * owns the aggregation (Prisma groupBy or InMemory SUM).
 */
export class GetLowStockAlerts {
  constructor(private readonly materialRepo: MaterialCatalogRepository) {}

  async execute(): Promise<LowStockAlertDTO[]> {
    return this.materialRepo.listLowStock();
  }
}
