import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';

describe('RemoveContractService', () => {
  let csRepo: InMemoryContractServiceRepository;
  let uc: RemoveContractService;

  beforeEach(() => {
    csRepo = new InMemoryContractServiceRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
    uc = new RemoveContractService(csRepo);
  });

  // CSV-3.1
  it('deletes an existing service', async () => {
    const cs = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    await uc.execute(cs.id);
    expect(await csRepo.getById(cs.id)).toBeNull();
  });

  // CSV-3.2 — idempotent: removing a non-existent service does not throw
  it('is idempotent for a non-existent id', async () => {
    await expect(uc.execute('nope')).resolves.toBeUndefined();
  });
});
