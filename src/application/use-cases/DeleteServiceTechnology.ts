import { ServiceTechnologyRepository } from '@domain/ports/ServiceTechnologyRepository';
import { ServiceTechnologyNotFoundError, ServiceTechnologyInUseError } from '@domain/errors/serviceTechnology';

export class DeleteServiceTechnology {
  constructor(private readonly repo: ServiceTechnologyRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new ServiceTechnologyNotFoundError(id);

    // Services store technology as a free-text name column — guard by name.
    const count = await this.repo.countServicesUsingTechnology(item.name);
    if (count > 0) throw new ServiceTechnologyInUseError(count);

    await this.repo.delete(id);
  }
}
