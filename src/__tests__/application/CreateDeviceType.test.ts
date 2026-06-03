import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { CreateDeviceType } from '@application/use-cases/CreateDeviceType';
import { DeviceTypeNameConflictError } from '@domain/errors/inventory';

describe('CreateDeviceType', () => {
  it('normalizes name to UPPERCASE and creates with active=true', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const create = new CreateDeviceType(repo);

    const result = await create.execute({ name: 'onu', sortOrder: 0 });

    expect(result.name).toBe('ONU');
    expect(result.active).toBe(true);
  });

  it('throws DeviceTypeNameConflictError on duplicate name (case-insensitive)', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const create = new CreateDeviceType(repo);
    await create.execute({ name: 'ONU', sortOrder: 0 });

    await expect(create.execute({ name: 'onu', sortOrder: 1 })).rejects.toBeInstanceOf(DeviceTypeNameConflictError);
  });

  it('does not insert a row when conflict is detected', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    const create = new CreateDeviceType(repo);
    await create.execute({ name: 'ONU', sortOrder: 0 });

    try { await create.execute({ name: 'ONU', sortOrder: 1 }); } catch { /* expected */ }

    const all = await repo.list();
    expect(all).toHaveLength(1);
  });
});
