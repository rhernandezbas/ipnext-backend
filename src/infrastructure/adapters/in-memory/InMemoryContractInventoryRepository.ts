import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

export class InMemoryContractInventoryRepository implements ContractInventoryRepository {
  readonly store = new Map<string, ContractInstalledItem>();

  async listByContract(contractId: string): Promise<ContractInstalledItem[]> {
    return Array.from(this.store.values()).filter(i => i.contractId === contractId);
  }

  async getById(id: string): Promise<ContractInstalledItem | null> {
    const item = this.store.get(id);
    return item ? { ...item } : null;
  }

  async create(item: ContractInstalledItem): Promise<ContractInstalledItem> {
    this.store.set(item.id, item);
    return item;
  }

  async update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    this.store.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<ContractInstalledItem | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, status: 'removed' as const, updatedAt: new Date().toISOString() };
    this.store.set(id, updated);
    return { ...updated };
  }
}
