/**
 * #73 — ListContractServiceHistory use-case tests.
 * InMemory adapter; verifies active+inactive both returned; deactivatedAt set on inactivation;
 * reactivation nulls it; empty contract returns []; tvPassword never in result.
 */
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

async function setup() {
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const csRepo = new InMemoryContractServiceRepository();
  const uc = new ListContractServiceHistory(csRepo);

  const cat = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 0 });
  csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };

  return { csRepo, catalogRepo, uc, catId: cat.id };
}

describe('ListContractServiceHistory', () => {
  // H-1: returns both active and inactive rows for a contract
  it('returns active + inactive rows for the contract', async () => {
    const { csRepo, uc, catId } = await setup();
    const active = await csRepo.add({ contractId: 'C', serviceCatalogId: catId, notes: 'n1' });
    // Seed a second catalog entry for the inactive row
    const cat2 = { id: 'cat2' };
    csRepo.catalog['cat2'] = { name: 'TV', label: null };
    const inactive = await csRepo.add({ contractId: 'C', serviceCatalogId: 'cat2', notes: 'n2' });
    await csRepo.update(inactive.id, { status: 'inactive' });

    const result = await uc.execute('C');
    expect(result).toHaveLength(2);
    const ids = result.map(r => r.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(inactive.id);
  });

  // H-2: empty array for contract with no rows
  it('returns empty array for a contract with no rows', async () => {
    const { uc } = await setup();
    const result = await uc.execute('NOROWS');
    expect(result).toEqual([]);
  });

  // H-3: inactive row has deactivatedAt set
  it('inactive row has deactivatedAt set after update-to-inactive', async () => {
    const { csRepo, uc, catId } = await setup();
    const row = await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    await csRepo.update(row.id, { status: 'inactive' });

    const result = await uc.execute('C');
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('inactive');
    expect(result[0]!.deactivatedAt).not.toBeNull();
    expect(typeof result[0]!.deactivatedAt).toBe('string');
  });

  // H-4: reactivation nulls deactivatedAt
  it('reactivation nulls deactivatedAt', async () => {
    const { csRepo, uc, catId } = await setup();
    const row = await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    await csRepo.update(row.id, { status: 'inactive' });
    await csRepo.update(row.id, { status: 'active' });

    const result = await uc.execute('C');
    expect(result[0]!.status).toBe('active');
    expect(result[0]!.deactivatedAt).toBeNull();
  });

  // H-5: tvPassword is never present in the DTO
  it('tvPassword is never in the history DTO', async () => {
    const { csRepo, uc, catId } = await setup();
    await csRepo.add({ contractId: 'C', serviceCatalogId: catId, tvLogin: 'LOGIN1', tvPassword: 'PASS1' });

    const result = await uc.execute('C');
    expect(result).toHaveLength(1);
    expect((result[0] as any).tvPassword).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PASS1');
  });

  // H-6: tvLogin IS present when set
  it('tvLogin is present in the history DTO when set', async () => {
    const { csRepo, uc, catId } = await setup();
    await csRepo.add({ contractId: 'C', serviceCatalogId: catId, tvLogin: 'GIGA0001', tvPassword: 'secret' });

    const result = await uc.execute('C');
    expect(result[0]!.tvLogin).toBe('GIGA0001');
  });

  // H-7: ordered by createdAt ascending
  it('results are ordered by createdAt ascending', async () => {
    const { csRepo, uc, catId } = await setup();
    csRepo.catalog['cat2'] = { name: 'TV', label: null };
    const r1 = await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    const r2 = await csRepo.add({ contractId: 'C', serviceCatalogId: 'cat2' });

    const result = await uc.execute('C');
    expect(result[0]!.id).toBe(r1.id);
    expect(result[1]!.id).toBe(r2.id);
  });

  // H-8: only rows for the requested contractId
  it('only returns rows for the requested contractId', async () => {
    const { csRepo, uc, catId } = await setup();
    csRepo.catalog['cat2'] = { name: 'TV', label: null };
    await csRepo.add({ contractId: 'C', serviceCatalogId: catId });
    await csRepo.add({ contractId: 'OTHER', serviceCatalogId: 'cat2' });

    const result = await uc.execute('C');
    expect(result).toHaveLength(1);
    expect(result[0]!.contractId).toBe('C');
  });
});
