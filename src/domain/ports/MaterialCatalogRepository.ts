import { MaterialCatalog } from '../entities/material-catalog';

/**
 * Wave 7 (Capstone) — result item for the low-stock alerts endpoint.
 * Only materials with minStock > 0 AND SUM(qty) < minStock appear here.
 */
export interface LowStockAlertDTO {
  materialCatalogId: string;
  name: string;
  label: string | null;
  unit: string | null;
  totalQty: number;
  minStock: number;
  deficit: number;
}

export interface MaterialCatalogRepository {
  list(): Promise<MaterialCatalog[]>;
  getById(id: string): Promise<MaterialCatalog | null>;
  getByName(name: string): Promise<MaterialCatalog | null>;
  create(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number; minStock?: number }): Promise<MaterialCatalog>;
  update(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number; minStock: number }>): Promise<MaterialCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many TaskMaterialConsumption rows reference this material id (delete guard). */
  countInUse(materialId: string): Promise<number>;
  /** Active material NAMES (UPPERCASE) — the valid set for confirm/route validation. */
  listActiveNames(): Promise<string[]>;
  /**
   * Wave 7 (Capstone) — returns materials where minStock > 0 AND SUM(MaterialStock.qty) < minStock.
   * Runs a single aggregation (groupBy) — no N+1.
   */
  listLowStock(): Promise<LowStockAlertDTO[]>;
}
