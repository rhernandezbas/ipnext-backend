import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { ContractServiceDuplicateError } from '@domain/errors/contractServices';

describe('InMemoryContractServiceRepository (port parity)', () => {
  let repo: InMemoryContractServiceRepository;

  beforeEach(() => {
    repo = new InMemoryContractServiceRepository();
    repo.catalog['S1'] = { name: 'INTERNET', label: 'Internet' };
    repo.catalog['S2'] = { name: 'TV', label: null };
  });

  it('add returns a joined view with catalog name/label and default status active', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1', notes: 'p' });
    expect(cs.id).toBeTruthy();
    expect(cs.contractId).toBe('C');
    expect(cs.serviceCatalogId).toBe('S1');
    expect(cs.name).toBe('INTERNET');
    expect(cs.label).toBe('Internet');
    expect(cs.status).toBe('active');
    expect(cs.notes).toBe('p');
  });

  // W-2 — parity with the Prisma UNIQUE(contractId, serviceCatalogId): adding a
  // duplicate pair must throw ContractServiceDuplicateError (mirrors P2002 mapping).
  it('add throws ContractServiceDuplicateError on a duplicate (contractId, serviceCatalogId) pair', async () => {
    await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    await expect(repo.add({ contractId: 'C', serviceCatalogId: 'S1' })).rejects.toBeInstanceOf(
      ContractServiceDuplicateError,
    );
  });

  it('add allows the same catalog on a different contract', async () => {
    await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    const other = await repo.add({ contractId: 'OTHER', serviceCatalogId: 'S1' });
    expect(other.contractId).toBe('OTHER');
  });

  it('getById returns the view or null', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    expect((await repo.getById(cs.id))?.id).toBe(cs.id);
    expect(await repo.getById('nope')).toBeNull();
  });

  it('getByPair finds by (contractId, serviceCatalogId)', async () => {
    await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    expect(await repo.getByPair('C', 'S1')).not.toBeNull();
    expect(await repo.getByPair('C', 'S2')).toBeNull();
    expect(await repo.getByPair('OTHER', 'S1')).toBeNull();
  });

  it('update patches status/notes and returns null for unknown id', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    const updated = await repo.update(cs.id, { status: 'inactive', notes: 'x' });
    expect(updated?.status).toBe('inactive');
    expect(updated?.notes).toBe('x');
    expect(await repo.update('nope', { status: 'inactive' })).toBeNull();
  });

  it('delete removes the row and returns false for unknown id', async () => {
    const cs = await repo.add({ contractId: 'C', serviceCatalogId: 'S1' });
    expect(await repo.delete(cs.id)).toBe(true);
    expect(await repo.getById(cs.id)).toBeNull();
    expect(await repo.delete('nope')).toBe(false);
  });
});
