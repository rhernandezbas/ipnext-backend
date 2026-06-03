import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { MaterialNotFoundError, MaterialProtectedError, MaterialInUseError } from '@domain/errors/inventory';

export class DeleteMaterial {
  constructor(private readonly repo: MaterialCatalogRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new MaterialNotFoundError(id);

    // OTRO is non-deletable — check BEFORE in-use count
    if (item.name === 'OTRO') throw new MaterialProtectedError();

    const count = await this.repo.countInUse(id);
    if (count > 0) throw new MaterialInUseError(count);

    await this.repo.delete(id);
  }
}
