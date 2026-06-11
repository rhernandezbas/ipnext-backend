import { UpdateServiceCatalog } from '@application/use-cases/UpdateServiceCatalog';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import {
  ServiceCatalogNotFoundError,
  ServiceCatalogNameConflictError,
  ServiceCatalogNonRenameableError,
} from '@domain/errors/contractServices';

describe('UpdateServiceCatalog', () => {
  let repo: InMemoryServiceCatalogRepository;
  let uc: UpdateServiceCatalog;

  beforeEach(() => {
    repo = new InMemoryServiceCatalogRepository();
    uc = new UpdateServiceCatalog(repo);
  });

  // SC-3.1
  it('partial update succeeds', async () => {
    const item = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    const updated = await uc.execute(item.id, { label: 'Internet hogar', active: false });
    expect(updated.label).toBe('Internet hogar');
    expect(updated.active).toBe(false);
    expect(updated.name).toBe('INTERNET');
  });

  // SC-3.2
  it('throws ServiceCatalogNameConflictError on name collision with another entry', async () => {
    await repo.create({ name: 'INTERNET', sortOrder: 0 });
    const b = await repo.create({ name: 'TV', sortOrder: 1 });
    await expect(uc.execute(b.id, { name: 'INTERNET' })).rejects.toBeInstanceOf(ServiceCatalogNameConflictError);
  });

  // SC-3.3
  it('throws ServiceCatalogNotFoundError for non-existent id', async () => {
    await expect(uc.execute('nope', { label: 'x' })).rejects.toBeInstanceOf(ServiceCatalogNotFoundError);
  });

  it('renaming to its own name (case change) does not conflict', async () => {
    const item = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    const updated = await uc.execute(item.id, { name: 'internet' });
    expect(updated.name).toBe('INTERNET');
  });

  // W-1 — OTROS is the protected catch-all; renaming it would let admins bypass the
  // non-deletable guard (rename OTROS → "X", then create a fresh deletable "OTROS").
  it('blocks renaming OTROS to a different name (422 NON_RENAMEABLE)', async () => {
    const otros = await repo.create({ name: 'OTROS', sortOrder: 4 });
    await expect(uc.execute(otros.id, { name: 'MISC' })).rejects.toBeInstanceOf(
      ServiceCatalogNonRenameableError,
    );
  });

  it('allows editing OTROS label/active/sortOrder (only the name is frozen)', async () => {
    const otros = await repo.create({ name: 'OTROS', sortOrder: 4 });
    const updated = await uc.execute(otros.id, { label: 'Otros servicios', sortOrder: 9 });
    expect(updated.label).toBe('Otros servicios');
    expect(updated.sortOrder).toBe(9);
    expect(updated.name).toBe('OTROS');
  });

  it('allows a no-op name on OTROS (same name, case-insensitive)', async () => {
    const otros = await repo.create({ name: 'OTROS', sortOrder: 4 });
    const updated = await uc.execute(otros.id, { name: 'otros' });
    expect(updated.name).toBe('OTROS');
  });
});
