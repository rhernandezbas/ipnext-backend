import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';

export class MaterialCatalogService {
  private cache: Set<string> | null = null;
  constructor(private readonly repo: MaterialCatalogRepository) {}

  async ensure(): Promise<Set<string>> {
    if (!this.cache) this.cache = new Set(await this.repo.listActiveNames());
    return this.cache;
  }

  invalidate(): void { this.cache = null; }

  async isValid(name: string | null | undefined): Promise<boolean> {
    if (!name) return false;
    return (await this.ensure()).has(name.toUpperCase());
  }
}
