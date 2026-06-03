import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { GetDeviceType } from '@application/use-cases/GetDeviceType';
import { DeviceTypeNotFoundError } from '@domain/errors/inventory';

describe('GetDeviceType', () => {
  it('returns the device type by id', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const created = await repo.create({ name: 'ONU', sortOrder: 0 });

    const get = new GetDeviceType(repo);
    const result = await get.execute(created.id);

    expect(result.name).toBe('ONU');
  });

  it('throws DeviceTypeNotFoundError for unknown id', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const get = new GetDeviceType(repo);
    await expect(get.execute('nonexistent')).rejects.toBeInstanceOf(DeviceTypeNotFoundError);
  });
});
