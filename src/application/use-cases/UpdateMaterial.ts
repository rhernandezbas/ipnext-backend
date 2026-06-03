import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import { MaterialNotFoundError, MaterialNameConflictError } from '@domain/errors/inventory';

export class UpdateMaterial {
  constructor(private readonly repo: MaterialCatalogRepository) {}
  async execute(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number }>): Promise<MaterialCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new MaterialNotFoundError(id);

    let patch = { ...data };
    if (data.name) {
      const normalized = data.name.trim().toUpperCase();
      if (normalized.toLowerCase() !== item.name.toLowerCase()) {
        const conflict = await this.repo.getByName(normalized);
        if (conflict && conflict.id !== id) throw new MaterialNameConflictError(normalized);
      }
      patch = { ...patch, name: normalized };
    }

    const updated = await this.repo.update(id, patch);
    if (!updated) throw new MaterialNotFoundError(id);
    return updated;
  }
}
