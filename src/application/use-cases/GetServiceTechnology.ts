import { ServiceTechnologyRepository } from '@domain/ports/ServiceTechnologyRepository';
import { ServiceTechnology } from '@domain/entities/serviceTechnology';
import { ServiceTechnologyNotFoundError } from '@domain/errors/serviceTechnology';

export class GetServiceTechnology {
  constructor(private readonly repo: ServiceTechnologyRepository) {}
  async execute(id: string): Promise<ServiceTechnology> {
    const item = await this.repo.getById(id);
    if (!item) throw new ServiceTechnologyNotFoundError(id);
    return item;
  }
}
