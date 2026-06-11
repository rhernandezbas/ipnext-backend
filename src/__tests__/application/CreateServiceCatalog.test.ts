import { CreateServiceCatalog } from '@application/use-cases/CreateServiceCatalog';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { ServiceCatalogNameConflictError } from '@domain/errors/contractServices';

describe('CreateServiceCatalog', () => {
  let repo: InMemoryServiceCatalogRepository;
  let uc: CreateServiceCatalog;

  beforeEach(() => {
    repo = new InMemoryServiceCatalogRepository();
    uc = new CreateServiceCatalog(repo);
  });

  // SC-2.1
  it('creates an entry, normalizing the name to UPPERCASE', async () => {
    const created = await uc.execute({ name: 'fibra', label: 'Fibra óptica', sortOrder: 10 });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('FIBRA');
    expect(created.active).toBe(true);
    expect(created.label).toBe('Fibra óptica');
  });

  // SC-2.2
  it('throws ServiceCatalogNameConflictError on duplicate name (case-insensitive)', async () => {
    await repo.create({ name: 'INTERNET', sortOrder: 0 });
    await expect(uc.execute({ name: 'internet' })).rejects.toBeInstanceOf(ServiceCatalogNameConflictError);
  });
});
