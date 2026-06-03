import { MaterialCatalog } from '../entities/material-catalog';

export interface MaterialCatalogRepository {
  list(): Promise<MaterialCatalog[]>;
  getById(id: string): Promise<MaterialCatalog | null>;
  getByName(name: string): Promise<MaterialCatalog | null>;
  create(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number }): Promise<MaterialCatalog>;
  update(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number }>): Promise<MaterialCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many TaskMaterialConsumption rows reference this material id (delete guard). */
  countInUse(materialId: string): Promise<number>;
  /** Active material NAMES (UPPERCASE) — the valid set for confirm/route validation. */
  listActiveNames(): Promise<string[]>;
}
