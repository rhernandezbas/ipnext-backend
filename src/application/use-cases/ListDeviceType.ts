import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { DeviceTypeCatalog } from '@domain/entities/device-type-catalog';

export class ListDeviceType {
  constructor(private readonly repo: DeviceTypeCatalogRepository) {}
  async execute(): Promise<DeviceTypeCatalog[]> {
    return this.repo.list();
  }
}
