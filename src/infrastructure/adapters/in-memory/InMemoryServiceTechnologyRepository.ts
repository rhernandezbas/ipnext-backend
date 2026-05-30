import { randomUUID } from 'crypto';
import { ServiceTechnology } from '@domain/entities/serviceTechnology';
import { ServiceTechnologyRepository } from '@domain/ports/ServiceTechnologyRepository';

export class InMemoryServiceTechnologyRepository implements ServiceTechnologyRepository {
  private items: ServiceTechnology[] = [];
  /** Test seam: service-count-per-technology-name, so DeleteServiceTechnology guard can be exercised. */
  public serviceCounts: Record<string, number> = {};

  async list(): Promise<ServiceTechnology[]> {
    return this.items.map(i => ({ ...i }));
  }

  async getById(id: string): Promise<ServiceTechnology | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<ServiceTechnology | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ServiceTechnology> {
    const item: ServiceTechnology = { id: randomUUID(), name: data.name, description: data.description };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ServiceTechnology | null> {
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

  async countServicesUsingTechnology(name: string): Promise<number> {
    return this.serviceCounts[name] ?? 0;
  }
}
