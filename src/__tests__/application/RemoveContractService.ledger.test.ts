/**
 * #110 — RemoveContractService ledger wiring tests (R2.4, R2.5).
 * Tests: active service → deactivated event; nonexistent id → no event; best-effort.
 */
import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

describe('RemoveContractService — #110 ledger wiring', () => {
  let csRepo: InMemoryContractServiceRepository;
  let cseRepo: InMemoryContractServiceEventRepository;

  beforeEach(() => {
    csRepo  = new InMemoryContractServiceRepository();
    cseRepo = new InMemoryContractServiceEventRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
  });

  function makeUc(eventRepo?: ContractServiceEventRepository) {
    return new RemoveContractService(csRepo, eventRepo);
  }

  // R2.4 — active service removed → deactivated event
  it('R2.4 removes active service and registers deactivated event', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = makeUc(cseRepo);
    await uc.execute(svc.id, { actorId: 'U1', actorName: 'Alice' });

    expect(await csRepo.getById(svc.id)).toBeNull();
    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.actorId).toBe('U1');
  });

  // R2.4 — nonexistent id → no event
  it('R2.4 nonexistent id → idempotent, no event registered', async () => {
    const uc = makeUc(cseRepo);
    await uc.execute('nope');
    expect(cseRepo.all()).toHaveLength(0);
  });

  // R2.4 — inactive service removed → still registers deactivated (it was there)
  // Actually per design: "si existía y estaba active" — inactive already deactivated, skip
  it('R2.4 inactive service removed → no additional event (already deactivated)', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    await csRepo.update(svc.id, { status: 'inactive' });
    const uc = makeUc(cseRepo);
    await uc.execute(svc.id);

    expect(await csRepo.getById(svc.id)).toBeNull();
    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(0);
  });

  // R2.5 — best-effort: event repo failure does NOT abort the delete
  it('R2.5 best-effort: record failure does not abort RemoveContractService', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const brokenEventRepo: ContractServiceEventRepository = {
      record: async () => { throw new Error('DB down'); },
      listByContract: async () => [],
    };
    const uc = makeUc(brokenEventRepo);
    await uc.execute(svc.id);
    // Service must be deleted despite event failure
    expect(await csRepo.getById(svc.id)).toBeNull();
  });

  // backward compat
  it('backward compat: no eventRepo → remove works without event repo', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = makeUc();
    await uc.execute(svc.id);
    expect(await csRepo.getById(svc.id)).toBeNull();
  });
});
