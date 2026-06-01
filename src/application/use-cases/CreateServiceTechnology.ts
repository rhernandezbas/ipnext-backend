import { ServiceTechnologyRepository } from '@domain/ports/ServiceTechnologyRepository';
import { ServiceTechnology } from '@domain/entities/serviceTechnology';
import { ServiceTechnologyNameConflictError } from '@domain/errors/serviceTechnology';

export class CreateServiceTechnology {
  constructor(private readonly repo: ServiceTechnologyRepository) {}
  async execute(data: { name: string; description?: string | null }): Promise<ServiceTechnology> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new ServiceTechnologyNameConflictError(data.name);
    return this.repo.create({ name: data.name, description: data.description ?? null });
  }
}
