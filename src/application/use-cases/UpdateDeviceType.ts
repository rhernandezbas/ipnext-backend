import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import {
  DeviceTypeNotFoundError,
  DeviceTypeNameConflictError,
  DeviceTypeNonRenameableError,
} from '@domain/errors/inventory';

export class UpdateDeviceType {
  constructor(private readonly repo: DeviceTypeCatalogRepository) {}
  async execute(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<DeviceTypeCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new DeviceTypeNotFoundError(id);

    let patch = { ...data };
    if (data.name) {
      const normalized = data.name.trim().toUpperCase();
      const isRename = normalized.toLowerCase() !== item.name.toLowerCase();
      if (isRename) {
        // #43 — OTROS is the protected catch-all; its name is frozen. Renaming it
        // would bypass the non-deletable guard. A no-op name (same value) is allowed.
        if (item.name === 'OTROS') throw new DeviceTypeNonRenameableError();
        const conflict = await this.repo.getByName(normalized);
        if (conflict && conflict.id !== id) throw new DeviceTypeNameConflictError(normalized);
      }
      patch = { ...patch, name: normalized };
    }

    const updated = await this.repo.update(id, patch);
    if (!updated) throw new DeviceTypeNotFoundError(id);
    return updated;
  }
}
