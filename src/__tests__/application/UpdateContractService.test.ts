import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { ContractServiceNotFoundError } from '@domain/errors/contractServices';

describe('UpdateContractService', () => {
  let csRepo: InMemoryContractServiceRepository;
  let uc: UpdateContractService;

  beforeEach(() => {
    csRepo = new InMemoryContractServiceRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
    uc = new UpdateContractService(csRepo);
  });

  // CSV-2.1
  it('updates status to inactive', async () => {
    const cs = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const updated = await uc.execute(cs.id, { status: 'inactive' });
    expect(updated.status).toBe('inactive');
  });

  // CSV-2.2
  it('updates notes only', async () => {
    const cs = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S', notes: 'a' });
    const updated = await uc.execute(cs.id, { notes: 'secundario' });
    expect(updated.notes).toBe('secundario');
    expect(updated.status).toBe('active');
  });

  // CSV-2.3
  it('reactivates an inactive service', async () => {
    const cs = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    await uc.execute(cs.id, { status: 'inactive' });
    const updated = await uc.execute(cs.id, { status: 'active' });
    expect(updated.status).toBe('active');
  });

  // CSV-2.4
  it('throws ContractServiceNotFoundError for unknown id', async () => {
    await expect(uc.execute('nope', { status: 'inactive' })).rejects.toBeInstanceOf(ContractServiceNotFoundError);
  });
});
