import { ServiceRepository, ServiceStats } from '@domain/ports/ServiceRepository';

export class GetServiceStats {
  constructor(private readonly repo: ServiceRepository) {}

  execute(): Promise<ServiceStats> {
    return this.repo.stats();
  }
}
