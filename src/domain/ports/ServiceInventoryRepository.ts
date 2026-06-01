import { ServiceInstalledItem } from '@domain/entities/service-installed-item';

export interface ServiceInventoryRepository {
  listByService(serviceId: string): Promise<ServiceInstalledItem[]>;
  create(item: ServiceInstalledItem): Promise<ServiceInstalledItem>;
  update(id: string, patch: Partial<ServiceInstalledItem>): Promise<ServiceInstalledItem | null>;
}
