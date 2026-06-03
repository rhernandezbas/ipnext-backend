import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { UpdateDeviceType } from '@application/use-cases/UpdateDeviceType';
import { DeviceTypeNotFoundError, DeviceTypeNameConflictError } from '@domain/errors/inventory';

describe('UpdateDeviceType', () => {
  it('applies a partial patch', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ONU', sortOrder: 0 });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(item.id, { label: 'Óptica', sortOrder: 5 });

    expect(result.label).toBe('Óptica');
    expect(result.sortOrder).toBe(5);
    expect(result.name).toBe('ONU'); // unchanged
  });

  it('throws DeviceTypeNotFoundError for unknown id', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const update = new UpdateDeviceType(repo);
    await expect(update.execute('nonexistent', { label: 'x' })).rejects.toBeInstanceOf(DeviceTypeNotFoundError);
  });

  it('throws DeviceTypeNameConflictError on rename collision (case-insensitive)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ONU', sortOrder: 0 });
    const router = await repo.create({ name: 'ROUTER', sortOrder: 1 });

    const update = new UpdateDeviceType(repo);
    await expect(update.execute(router.id, { name: 'onu' })).rejects.toBeInstanceOf(DeviceTypeNameConflictError);
  });

  it('normalizes renamed name to UPPERCASE', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ONU', sortOrder: 0 });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(item.id, { name: 'optical' });

    expect(result.name).toBe('OPTICAL');
  });

  it('deactivating a non-OTROS entry succeeds', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const item = await repo.create({ name: 'ROUTER', sortOrder: 1, active: true });

    const update = new UpdateDeviceType(repo);
    const result = await update.execute(item.id, { active: false });

    expect(result.active).toBe(false);
  });
});
