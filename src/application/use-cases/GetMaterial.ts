import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import { MaterialNotFoundError } from '@domain/errors/inventory';

export class GetMaterial {
  constructor(private readonly repo: MaterialCatalogRepository) {}
  async execute(id: string): Promise<MaterialCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new MaterialNotFoundError(id);
    return item;
  }
}
