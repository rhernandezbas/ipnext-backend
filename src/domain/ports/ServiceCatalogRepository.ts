import { ServiceCatalog } from '../entities/service-catalog';

export interface ServiceCatalogRepository {
  /** List entries ordered by sortOrder ASC. `filter.active` narrows to active entries. */
  list(filter?: { active?: boolean }): Promise<ServiceCatalog[]>;
  getById(id: string): Promise<ServiceCatalog | null>;
  getByName(name: string): Promise<ServiceCatalog | null>;
  create(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<ServiceCatalog>;
  update(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<ServiceCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many ContractService rows reference this catalog id (delete guard). */
  countInUse(catalogId: string): Promise<number>;
}
