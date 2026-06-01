import { ServiceInventoryRepository } from '@domain/ports/ServiceInventoryRepository';
import { ServiceInstalledItem } from '@domain/entities/service-installed-item';

export class InMemoryServiceInventoryRepository implements ServiceInventoryRepository {
  readonly store = new Map<string, ServiceInstalledItem>();

  async listByService(serviceId: string): Promise<ServiceInstalledItem[]> {
    return Array.from(this.store.values()).filter(i => i.serviceId === serviceId);
  }

  async create(item: ServiceInstalledItem): Promise<ServiceInstalledItem> {
    this.store.set(item.id, item);
    return item;
  }

  async update(id: string, patch: Partial<ServiceInstalledItem>): Promise<ServiceInstalledItem | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    this.store.set(id, updated);
    return updated;
  }
}
