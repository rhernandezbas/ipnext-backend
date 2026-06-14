import { IClassStatusCatalogEntry } from '@domain/entities/iclass-status-catalog';
import { IClassStatusCatalogRepository } from '@domain/ports/IClassStatusCatalogRepository';

/**
 * Lists all IClass status catalog entries (auto-discovered + configured).
 * Returns them ordered by statusCode (alphabetical).
 */
export class ListIClassStatusCatalog {
  constructor(private readonly repo: IClassStatusCatalogRepository) {}

  async execute(): Promise<IClassStatusCatalogEntry[]> {
    return this.repo.list();
  }
}
