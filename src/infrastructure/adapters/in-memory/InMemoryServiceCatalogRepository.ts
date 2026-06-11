import { randomUUID } from 'crypto';
import { ServiceCatalog } from '@domain/entities/service-catalog';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';

export class InMemoryServiceCatalogRepository implements ServiceCatalogRepository {
  private items: ServiceCatalog[] = [];
  /** Test seam: in-use ContractService counts keyed by catalog id (DeleteServiceCatalog guard). */
  public itemCounts: Record<string, number> = {};

  async list(filter?: { active?: boolean }): Promise<ServiceCatalog[]> {
    let result = [...this.items];
    if (filter?.active !== undefined) {
      result = result.filter(i => i.active === filter.active);
    }
    return result.sort((a, b) => a.sortOrder - b.sortOrder).map(i => ({ ...i }));
  }

  async getById(id: string): Promise<ServiceCatalog | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<ServiceCatalog | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<ServiceCatalog> {
    const now = new Date().toISOString();
    const item: ServiceCatalog = {
      id: randomUUID(),
      name: data.name,
      label: data.label ?? null,
      active: data.active ?? true,
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<ServiceCatalog | null> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index], ...data, updatedAt: new Date().toISOString() };
    return { ...this.items[index] };
  }

  async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  async countInUse(catalogId: string): Promise<number> {
    return this.itemCounts[catalogId] ?? 0;
  }
}
