import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import { MaterialNameConflictError } from '@domain/errors/inventory';

export class CreateMaterial {
  constructor(private readonly repo: MaterialCatalogRepository) {}
  async execute(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number; minStock?: number }): Promise<MaterialCatalog> {
    const normalized = data.name.trim().toUpperCase();
    const existing = await this.repo.getByName(normalized);
    if (existing) throw new MaterialNameConflictError(normalized);
    const unit = data.unit ?? 'unidad';
    return this.repo.create({ ...data, name: normalized, unit });
  }
}
