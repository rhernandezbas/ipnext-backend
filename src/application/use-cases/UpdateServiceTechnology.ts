import { ServiceTechnologyRepository } from '@domain/ports/ServiceTechnologyRepository';
import { ServiceTechnology } from '@domain/entities/serviceTechnology';
import { ServiceTechnologyNotFoundError, ServiceTechnologyNameConflictError } from '@domain/errors/serviceTechnology';

export class UpdateServiceTechnology {
  constructor(private readonly repo: ServiceTechnologyRepository) {}
  async execute(id: string, data: { name?: string; description?: string | null }): Promise<ServiceTechnology> {
    const item = await this.repo.getById(id);
    if (!item) throw new ServiceTechnologyNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new ServiceTechnologyNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new ServiceTechnologyNotFoundError(id);
    return updated;
  }
}
