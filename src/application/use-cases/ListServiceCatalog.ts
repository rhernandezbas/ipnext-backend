import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ServiceCatalog } from '@domain/entities/service-catalog';

export class ListServiceCatalog {
  constructor(private readonly repo: ServiceCatalogRepository) {}
  async execute(filter?: { active?: boolean }): Promise<ServiceCatalog[]> {
    return this.repo.list(filter);
  }
}
