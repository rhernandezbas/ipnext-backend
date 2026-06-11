import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import {
  ServiceCatalogNotFoundError,
  ServiceCatalogProtectedError,
  ServiceCatalogInUseError,
} from '@domain/errors/contractServices';

export class DeleteServiceCatalog {
  constructor(private readonly repo: ServiceCatalogRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new ServiceCatalogNotFoundError(id);

    // OTROS is non-deletable — check BEFORE the in-use count (spec SC-4.3, pinned order).
    if (item.name === 'OTROS') throw new ServiceCatalogProtectedError();

    const count = await this.repo.countInUse(id);
    if (count > 0) throw new ServiceCatalogInUseError(count);

    await this.repo.delete(id);
  }
}
