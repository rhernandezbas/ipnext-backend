import { randomUUID } from 'crypto';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';

export class InMemoryDeviceTypeCatalogRepository implements DeviceTypeCatalogRepository {
  private items: DeviceTypeCatalog[] = [];
  /** Test seam: installed-items-per-type-name counts for the DeleteDeviceType guard. */
  public itemCounts: Record<string, number> = {};

  async list(): Promise<DeviceTypeCatalog[]> {
    return [...this.items].sort((a, b) => a.sortOrder - b.sortOrder).map(i => ({ ...i }));
  }

  async getById(id: string): Promise<DeviceTypeCatalog | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<DeviceTypeCatalog | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<DeviceTypeCatalog> {
    const item: DeviceTypeCatalog = {
      id: randomUUID(),
      name: data.name,
      label: data.label ?? null,
      active: data.active ?? true,
      sortOrder: data.sortOrder ?? 0,
    };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<DeviceTypeCatalog | null> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index], ...data };
    return { ...this.items[index] };
  }

  async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  async countInUse(typeName: string): Promise<number> {
    return this.itemCounts[typeName] ?? 0;
  }

  async listActiveNames(): Promise<string[]> {
    return this.items
      .filter(i => i.active)
      .map(i => i.name.toUpperCase());
  }
}
