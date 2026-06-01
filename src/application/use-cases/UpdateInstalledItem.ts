import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

export interface UpdateInstalledItemInput {
  status?: ContractInstalledItem['status'];
  notes?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  mac?: string | null;
}

/** Edits an installed item (status active/removed/replaced, notes, etc.). */
export class UpdateInstalledItem {
  constructor(private readonly inventory: ContractInventoryRepository) {}

  execute(itemId: string, patch: UpdateInstalledItemInput): Promise<ContractInstalledItem | null> {
    return this.inventory.update(itemId, patch);
  }
}
