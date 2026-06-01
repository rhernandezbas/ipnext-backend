import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

export interface ContractInventoryRepository {
  listByContract(contractId: string): Promise<ContractInstalledItem[]>;
  create(item: ContractInstalledItem): Promise<ContractInstalledItem>;
  update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null>;
}
