import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

/** Lists the installed inventory of a contract. */
export class ListContractInstalledItems {
  constructor(private readonly inventory: ContractInventoryRepository) {}

  execute(contractId: string): Promise<ContractInstalledItem[]> {
    return this.inventory.listByContract(contractId);
  }
}
