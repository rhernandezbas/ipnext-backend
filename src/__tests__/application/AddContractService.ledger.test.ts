/**
 * #110 — AddContractService ledger wiring tests (R2.1, R2.5).
 * Tests: registers 'activated' event; best-effort if record fails.
 */
import { AddContractService } from '@application/use-cases/AddContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

describe('AddContractService — #110 ledger wiring', () => {
  let csRepo: InMemoryContractServiceRepository;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let cseRepo: InMemoryContractServiceEventRepository;
  let contracts: Set<string>;

  beforeEach(() => {
    csRepo      = new InMemoryContractServiceRepository();
    catalogRepo = new InMemoryServiceCatalogRepository();
    cseRepo     = new InMemoryContractServiceEventRepository();
    contracts   = new Set<string>();
  });

  function makeUc(eventRepo?: ContractServiceEventRepository) {
    const contractLookup = { findById: async (id: string) => (contracts.has(id) ? { id } : null) };
    return new AddContractService(csRepo, catalogRepo, contractLookup, eventRepo);
  }

  // R2.1 — add registers 'activated' event
  it('R2.1 add registers activated event with actorId/actorName', async () => {
    contracts.add('C');
    const cat = await catalogRepo.create({ name: 'INTERNET', label: null, active: true, sortOrder: 0 });
    csRepo.catalog[cat.id] = { name: cat.name, label: null };

    const uc = makeUc(cseRepo);
    await uc.execute('C', { serviceCatalogId: cat.id }, { actorId: 'U1', actorName: 'Alice' });

    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    expect(events[0]!.actorId).toBe('U1');
    expect(events[0]!.actorName).toBe('Alice');
    expect(events[0]!.contractId).toBe('C');
  });

  // R2.5 — best-effort: record failure does NOT abort the operation
  it('R2.5 best-effort: record failure does not abort AddContractService', async () => {
    contracts.add('C');
    const cat = await catalogRepo.create({ name: 'INTERNET', label: null, active: true, sortOrder: 0 });
    csRepo.catalog[cat.id] = { name: cat.name, label: null };

    const brokenEventRepo: ContractServiceEventRepository = {
      record: async () => { throw new Error('DB down'); },
      listByContract: async () => [],
    };

    const uc = makeUc(brokenEventRepo);
    // Must not throw even when the event repo fails
    const result = await uc.execute('C', { serviceCatalogId: cat.id });
    expect(result.contractId).toBe('C');
    expect(result.status).toBe('active');
  });

  // Without event repo injected: works normally (backward compat)
  it('backward compat: no eventRepo → add works, no event recorded', async () => {
    contracts.add('C');
    const cat = await catalogRepo.create({ name: 'INTERNET', label: null, active: true, sortOrder: 0 });
    csRepo.catalog[cat.id] = { name: cat.name, label: null };

    const uc = makeUc();
    const result = await uc.execute('C', { serviceCatalogId: cat.id });
    expect(result.contractId).toBe('C');
  });
});
