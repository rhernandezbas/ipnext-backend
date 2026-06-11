import { AddContractService } from '@application/use-cases/AddContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import {
  ContractNotFoundError,
  ServiceCatalogNotFoundError,
  ServiceCatalogInactiveError,
  ContractServiceDuplicateError,
} from '@domain/errors/contractServices';

describe('AddContractService', () => {
  let csRepo: InMemoryContractServiceRepository;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let contracts: Set<string>;
  let uc: AddContractService;

  beforeEach(() => {
    csRepo = new InMemoryContractServiceRepository();
    catalogRepo = new InMemoryServiceCatalogRepository();
    contracts = new Set<string>();
    const contractLookup = {
      findById: async (id: string) => (contracts.has(id) ? { id } : null),
    };
    uc = new AddContractService(csRepo, catalogRepo, contractLookup);
  });

  // CSV-1.1
  it('adds a service successfully, returning the joined view', async () => {
    contracts.add('C');
    const cat = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 0 });
    csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };

    const result = await uc.execute('C', { serviceCatalogId: cat.id, notes: 'principal' });
    expect(result.contractId).toBe('C');
    expect(result.serviceCatalogId).toBe(cat.id);
    expect(result.name).toBe('INTERNET');
    expect(result.status).toBe('active');
    expect(result.notes).toBe('principal');
  });

  // CSV-1.4 — contract guard runs FIRST
  it('throws ContractNotFoundError when the contract does not exist', async () => {
    const cat = await catalogRepo.create({ name: 'INTERNET', active: true, sortOrder: 0 });
    await expect(uc.execute('X', { serviceCatalogId: cat.id })).rejects.toBeInstanceOf(ContractNotFoundError);
  });

  // CSV-1.5
  it('throws ServiceCatalogNotFoundError when the catalog entry does not exist', async () => {
    contracts.add('C');
    await expect(uc.execute('C', { serviceCatalogId: '999' })).rejects.toBeInstanceOf(ServiceCatalogNotFoundError);
  });

  // CSV-1.3
  it('throws ServiceCatalogInactiveError when the catalog entry is inactive', async () => {
    contracts.add('C');
    const cat = await catalogRepo.create({ name: 'TV', active: false, sortOrder: 1 });
    await expect(uc.execute('C', { serviceCatalogId: cat.id })).rejects.toBeInstanceOf(ServiceCatalogInactiveError);
  });

  // CSV-1.2
  it('throws ContractServiceDuplicateError when the (contract, catalog) pair already exists', async () => {
    contracts.add('C');
    const cat = await catalogRepo.create({ name: 'INTERNET', active: true, sortOrder: 0 });
    csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };
    await uc.execute('C', { serviceCatalogId: cat.id });
    await expect(uc.execute('C', { serviceCatalogId: cat.id })).rejects.toBeInstanceOf(ContractServiceDuplicateError);
  });
});
