import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

export interface ContractInventoryRepository {
  listByContract(contractId: string): Promise<ContractInstalledItem[]>;
  getById(id: string): Promise<ContractInstalledItem | null>;
  create(item: ContractInstalledItem): Promise<ContractInstalledItem>;
  update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null>;
  /** Soft-delete: status -> 'removed'. Returns the updated item, or null if not found. */
  remove(id: string): Promise<ContractInstalledItem | null>;
}
