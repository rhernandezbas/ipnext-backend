import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { DeviceTypeNotFoundError, DeviceTypeProtectedError, DeviceTypeInUseError } from '@domain/errors/inventory';

export class DeleteDeviceType {
  constructor(private readonly repo: DeviceTypeCatalogRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new DeviceTypeNotFoundError(id);

    // OTROS is non-deletable — check BEFORE in-use count (spec F1-5, B.1 task order)
    if (item.name === 'OTROS') throw new DeviceTypeProtectedError();

    const count = await this.repo.countInUse(item.name);
    if (count > 0) throw new DeviceTypeInUseError(count);

    await this.repo.delete(id);
  }
}
