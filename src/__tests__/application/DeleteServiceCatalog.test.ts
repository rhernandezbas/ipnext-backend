import { DeleteServiceCatalog } from '@application/use-cases/DeleteServiceCatalog';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import {
  ServiceCatalogNotFoundError,
  ServiceCatalogProtectedError,
  ServiceCatalogInUseError,
} from '@domain/errors/contractServices';

describe('DeleteServiceCatalog', () => {
  let repo: InMemoryServiceCatalogRepository;
  let uc: DeleteServiceCatalog;

  beforeEach(() => {
    repo = new InMemoryServiceCatalogRepository();
    uc = new DeleteServiceCatalog(repo);
  });

  // SC-4.1
  it('deletes an unused entry', async () => {
    const item = await repo.create({ name: 'FIBRA', sortOrder: 5 });
    await uc.execute(item.id);
    expect(await repo.getById(item.id)).toBeNull();
  });

  // SC-4.2
  it('throws ServiceCatalogInUseError when referenced by a ContractService', async () => {
    const item = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    repo.itemCounts[item.id] = 3;
    await expect(uc.execute(item.id)).rejects.toBeInstanceOf(ServiceCatalogInUseError);
  });

  // SC-4.3 — OTROS guard runs BEFORE the in-use count
  it('throws ServiceCatalogProtectedError for OTROS even with 0 references', async () => {
    const item = await repo.create({ name: 'OTROS', sortOrder: 4 });
    await expect(uc.execute(item.id)).rejects.toBeInstanceOf(ServiceCatalogProtectedError);
  });

  // SC-4.4
  it('throws ServiceCatalogNotFoundError for non-existent id', async () => {
    await expect(uc.execute('nope')).rejects.toBeInstanceOf(ServiceCatalogNotFoundError);
  });
});
