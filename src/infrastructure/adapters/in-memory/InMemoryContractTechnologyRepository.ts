import { randomUUID } from 'crypto';
import { ContractTechnology } from '@domain/entities/contractTechnology';
import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';

export class InMemoryContractTechnologyRepository implements ContractTechnologyRepository {
  private items: ContractTechnology[] = [];
  /** Test seam: contract-count-per-technology-name, so DeleteContractTechnology guard can be exercised. */
  public contractCounts: Record<string, number> = {};

  async list(): Promise<ContractTechnology[]> {
    // Order by name ascending to mirror the Prisma adapter (orderBy: { name: 'asc' }).
    return this.items
      .map(i => ({ ...i }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getById(id: string): Promise<ContractTechnology | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<ContractTechnology | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ContractTechnology> {
    const item: ContractTechnology = { id: randomUUID(), name: data.name, description: data.description };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ContractTechnology | null> {
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

  async countContractsUsingTechnology(name: string): Promise<number> {
    return this.contractCounts[name] ?? 0;
  }
}
