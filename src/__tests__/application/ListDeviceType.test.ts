import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { ListDeviceType } from '@application/use-cases/ListDeviceType';

describe('ListDeviceType', () => {
  it('returns all entries ordered by sortOrder', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ROUTER', sortOrder: 1 });
    await repo.create({ name: 'ONU', sortOrder: 0 });
    await repo.create({ name: 'ANTENA', sortOrder: 2 });

    const list = new ListDeviceType(repo);
    const result = await list.execute();

    expect(result.map(r => r.name)).toEqual(['ONU', 'ROUTER', 'ANTENA']);
  });

  it('returns all entries regardless of active flag', async () => {
    const repo = new InMemoryDeviceTypeCatalogRepository();
    await repo.create({ name: 'ONU', sortOrder: 0, active: true });
    await repo.create({ name: 'ROUTER', sortOrder: 1, active: false });

    const list = new ListDeviceType(repo);
    const result = await list.execute();

    expect(result).toHaveLength(2);
  });
});
