import { ServiceInventoryRepository } from '@domain/ports/ServiceInventoryRepository';
import { ServiceInstalledItem } from '@domain/entities/service-installed-item';

export interface UpdateInstalledItemInput {
  status?: ServiceInstalledItem['status'];
  notes?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  mac?: string | null;
}

/** Edits an installed item (status active/removed/replaced, notes, etc.). */
export class UpdateInstalledItem {
  constructor(private readonly inventory: ServiceInventoryRepository) {}

  execute(itemId: string, patch: UpdateInstalledItemInput): Promise<ServiceInstalledItem | null> {
    return this.inventory.update(itemId, patch);
  }
}
