import { ListServiceCatalog } from '@application/use-cases/ListServiceCatalog';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

describe('ListServiceCatalog', () => {
  let repo: InMemoryServiceCatalogRepository;
  let uc: ListServiceCatalog;

  beforeEach(() => {
    repo = new InMemoryServiceCatalogRepository();
    uc = new ListServiceCatalog(repo);
  });

  // SC-1.1
  it('returns all entries ordered by sortOrder ascending', async () => {
    await repo.create({ name: 'TV', sortOrder: 1 });
    await repo.create({ name: 'INTERNET', sortOrder: 0 });
    const all = await uc.execute();
    expect(all.map(e => e.name)).toEqual(['INTERNET', 'TV']);
  });

  // SC-1.2
  it('filter active=true excludes inactive entries', async () => {
    await repo.create({ name: 'INTERNET', sortOrder: 0, active: true });
    await repo.create({ name: 'OTROS', sortOrder: 4, active: false });
    const onlyActive = await uc.execute({ active: true });
    expect(onlyActive.map(e => e.name)).toEqual(['INTERNET']);
  });
});
