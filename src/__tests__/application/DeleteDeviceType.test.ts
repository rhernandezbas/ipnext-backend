import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { DeleteDeviceType } from '@application/use-cases/DeleteDeviceType';
import {
  DeviceTypeNotFoundError,
  DeviceTypeProtectedError,
  DeviceTypeInUseError,
} from '@domain/errors/inventory';

describe('DeleteDeviceType', () => {
  it('happy path: deletes an unused, unprotected type', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ANTENA', sortOrder: 2 });

    const del = new DeleteDeviceType(repo);
    await del.execute(item.id); // should not throw

    expect(await repo.getById(item.id)).toBeNull();
  });

  it('throws DeviceTypeNotFoundError for unknown id', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const del = new DeleteDeviceType(repo);
    await expect(del.execute('nonexistent')).rejects.toBeInstanceOf(DeviceTypeNotFoundError);
  });

  it('throws DeviceTypeProtectedError for OTROS BEFORE checking in-use count', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const otros = await repo.create({ name: 'OTROS', sortOrder: 4 });
    // also mark as in-use — but protected check should still fire first
    repo.itemCounts['OTROS'] = 99;

    const del = new DeleteDeviceType(repo);
    await expect(del.execute(otros.id)).rejects.toBeInstanceOf(DeviceTypeProtectedError);
  });

  it('throws DeviceTypeInUseError when the type is in use', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ROUTER', sortOrder: 1 });
    repo.itemCounts['ROUTER'] = 3;

    const del = new DeleteDeviceType(repo);
    await expect(del.execute(item.id)).rejects.toBeInstanceOf(DeviceTypeInUseError);
  });
});
