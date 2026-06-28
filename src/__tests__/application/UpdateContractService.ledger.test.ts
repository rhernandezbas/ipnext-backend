/**
 * #110 — UpdateContractService ledger wiring tests (R2.2, R2.3, R2.5).
 * Tests: active→inactive = deactivated; inactive→active = reactivated; no status change = no event.
 */
import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

describe('UpdateContractService — #110 ledger wiring', () => {
  let csRepo: InMemoryContractServiceRepository;
  let cseRepo: InMemoryContractServiceEventRepository;

  beforeEach(() => {
    csRepo  = new InMemoryContractServiceRepository();
    cseRepo = new InMemoryContractServiceEventRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
  });

  function makeUc(eventRepo?: ContractServiceEventRepository) {
    return new UpdateContractService(csRepo, eventRepo);
  }

  // R2.2 — active → inactive registers 'deactivated'
  it('R2.2 active→inactive registers deactivated event', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = makeUc(cseRepo);
    await uc.execute(svc.id, { status: 'inactive' }, { actorId: 'U1', actorName: 'Bob' });

    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.actorId).toBe('U1');
    expect(events[0]!.actorName).toBe('Bob');
  });

  // R2.2 — notes-only update → no event
  it('R2.2 notes-only update → no event registered', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = makeUc(cseRepo);
    await uc.execute(svc.id, { notes: 'new note' });

    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(0);
  });

  // R2.2 — same status (active→active) → no event
  it('R2.2 same status update → no event registered', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = makeUc(cseRepo);
    await uc.execute(svc.id, { status: 'active' });

    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(0);
  });

  // R2.3 — inactive → active registers 'reactivated'
  it('R2.3 inactive→active registers reactivated event', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    await csRepo.update(svc.id, { status: 'inactive' });
    const uc = makeUc(cseRepo);
    await uc.execute(svc.id, { status: 'active' }, { actorId: null, actorName: 'sys' });

    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('reactivated');
  });

  // R2.5 — event repo failure does NOT abort the update
  it('R2.5 best-effort: record failure does not abort UpdateContractService', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const brokenEventRepo: ContractServiceEventRepository = {
      record: async () => { throw new Error('DB down'); },
      listByContract: async () => [],
      list: async () => [],
      listDistinctOperators: async () => [],
    };
    const uc = makeUc(brokenEventRepo);
    const result = await uc.execute(svc.id, { status: 'inactive' });
    expect(result.status).toBe('inactive');
  });

  // backward compat: no eventRepo → update works, no event
  it('backward compat: no eventRepo → update works without event repo', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = makeUc();
    const result = await uc.execute(svc.id, { status: 'inactive' });
    expect(result.status).toBe('inactive');
  });
});
