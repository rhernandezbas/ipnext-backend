import { ServiceInventoryRepository } from '@domain/ports/ServiceInventoryRepository';
import { ServiceInstalledItem, InstalledItemType } from '@domain/entities/service-installed-item';
import { randomUUID } from 'crypto';

export interface AddInstalledItemInput {
  serviceId: string;
  type: InstalledItemType;
  serialNumber?: string | null;
  mac?: string | null;
  model?: string | null;
  notes?: string | null;
  addedByUserId?: string | null;
}

/**
 * Manually attach an installed device to a contract — the "agregar SN al
 * servicio" shortcut. Covers devices the OCR did not capture (e.g. a 2nd router).
 * source = MANUAL, no sourceTaskId.
 */
export class AddInstalledItemManually {
  constructor(private readonly inventory: ServiceInventoryRepository) {}

  async execute(input: AddInstalledItemInput): Promise<ServiceInstalledItem> {
    const now = new Date().toISOString();
    return this.inventory.create({
      id: randomUUID(),
      serviceId: input.serviceId,
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
      createdAt: now,
      updatedAt: now,
    });
  }
}
