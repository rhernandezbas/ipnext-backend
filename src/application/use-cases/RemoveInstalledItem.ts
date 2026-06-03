import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { InstalledItemNotFoundError } from '@domain/errors/inventory';

/**
 * Soft-deletes (status → 'removed') an installed item. IDEMPOTENT: removing an
 * item that is already removed/replaced is a no-op that returns the item as-is
 * (no error) — DELETE should be safe to repeat.
 */
export class RemoveInstalledItem {
  constructor(private readonly inventory: ContractInventoryRepository) {}

  async execute(itemId: string): Promise<ContractInstalledItem> {
    const item = await this.inventory.getById(itemId);
    if (!item) throw new InstalledItemNotFoundError(itemId);
    if (item.status !== 'active') return item; // idempotent no-op
    const removed = await this.inventory.remove(itemId);
    if (!removed) throw new InstalledItemNotFoundError(itemId);
    return removed;
  }
}
