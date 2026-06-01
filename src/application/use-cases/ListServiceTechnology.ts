import { ServiceTechnologyRepository } from '@domain/ports/ServiceTechnologyRepository';
import { ServiceTechnology } from '@domain/entities/serviceTechnology';

export class ListServiceTechnology {
  constructor(private readonly repo: ServiceTechnologyRepository) {}
  async execute(): Promise<ServiceTechnology[]> {
    return this.repo.list();
  }
}
