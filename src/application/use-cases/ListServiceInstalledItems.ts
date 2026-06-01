import { ServiceInventoryRepository } from '@domain/ports/ServiceInventoryRepository';
import { ServiceInstalledItem } from '@domain/entities/service-installed-item';

/** Lists the installed inventory of a contract (Service). */
export class ListServiceInstalledItems {
  constructor(private readonly inventory: ServiceInventoryRepository) {}

  execute(serviceId: string): Promise<ServiceInstalledItem[]> {
    return this.inventory.listByService(serviceId);
  }
}
