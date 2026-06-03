import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';
import { DeviceTypeNotFoundError } from '@domain/errors/inventory';

export class GetDeviceType {
  constructor(private readonly repo: DeviceTypeCatalogRepository) {}
  async execute(id: string): Promise<DeviceTypeCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new DeviceTypeNotFoundError(id);
    return item;
  }
}
