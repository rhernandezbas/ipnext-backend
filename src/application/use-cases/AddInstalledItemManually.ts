import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ContractInstalledItem, InstalledItemType } from '@domain/entities/contract-installed-item';
import { randomUUID } from 'crypto';

export interface AddInstalledItemInput {
  contractId: string;
  type: InstalledItemType;
  serialNumber?: string | null;
  mac?: string | null;
  model?: string | null;
  notes?: string | null;
  addedByUserId?: string | null;
}

/**
 * Manually attach an installed device to a contract — the "agregar SN al
 * contrato" shortcut. Covers devices the OCR did not capture (e.g. a 2nd router).
 * source = MANUAL, no sourceTaskId.
 */
export class AddInstalledItemManually {
  constructor(private readonly inventory: ContractInventoryRepository) {}

  async execute(input: AddInstalledItemInput): Promise<ContractInstalledItem> {
    const now = new Date().toISOString();
    return this.inventory.create({
      id: randomUUID(),
      contractId: input.contractId,
      type: input.type,
      serialNumber: input.serialNumber ?? null,
      mac: input.mac ?? null,
      model: input.model ?? null,
      source: 'MANUAL',
      sourceTaskId: null,
      addedByUserId: input.addedByUserId ?? null,
      confirmedAt: now,
      status: 'active',
      notes: input.notes ?? null,
      replacesItemId: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}
