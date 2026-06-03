import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { MaterialCatalog } from '@domain/entities/material-catalog';

export class ListMaterial {
  constructor(private readonly repo: MaterialCatalogRepository) {}
  async execute(): Promise<MaterialCatalog[]> {
    return this.repo.list();
  }
}
