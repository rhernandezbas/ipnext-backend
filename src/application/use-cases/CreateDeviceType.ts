import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import { DeviceTypeNameConflictError } from '@domain/errors/inventory';

export class CreateDeviceType {
  constructor(private readonly repo: DeviceTypeCatalogRepository) {}
  async execute(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<DeviceTypeCatalog> {
    const normalized = data.name.trim().toUpperCase();
    const existing = await this.repo.getByName(normalized);
    if (existing) throw new DeviceTypeNameConflictError(normalized);
    return this.repo.create({ ...data, name: normalized });
  }
}
