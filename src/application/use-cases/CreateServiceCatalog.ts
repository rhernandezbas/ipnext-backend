import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ServiceCatalog } from '@domain/entities/service-catalog';
import { ServiceCatalogNameConflictError } from '@domain/errors/contractServices';

export class CreateServiceCatalog {
  constructor(private readonly repo: ServiceCatalogRepository) {}
  async execute(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<ServiceCatalog> {
    const normalized = data.name.trim().toUpperCase();
    const existing = await this.repo.getByName(normalized);
    if (existing) throw new ServiceCatalogNameConflictError(normalized);
    return this.repo.create({ ...data, name: normalized });
  }
}
