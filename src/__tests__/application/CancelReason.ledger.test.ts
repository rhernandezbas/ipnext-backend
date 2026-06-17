// #127 - reason field end-to-end ledger tests

import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { tvEventToServiceEvent } from '@application/dto/contract-services.dto';
import type { CancelTv } from '@application/use-cases/gigared/CancelTv';
import type { ClientTvCancelStatusRepository } from '@domain/ports/ClientTvCancelStatusRepository';
import type { CancelTvResult } from '@application/dto/gigared.dto';

function makeCancelStatus(): ClientTvCancelStatusRepository {
  return { getStatus: jest.fn(async () => null), setStatus: jest.fn(async () => {}) };
}

function makeResult(over: Partial<CancelTvResult> = {}): CancelTvResult {
  return { removed: [], failed: [], unremovable: [], ottDisabled: true, local: 'synced',
    renew: { oldCic: 'OLD', newCic: 'NEW' }, localCancelled: true, renewAttempted: true, cic: 'OLD', ...over };
}

function makeCancelTv(result: CancelTvResult): CancelTv {
  return { execute: jest.fn(async () => result) } as unknown as CancelTv;
}

describe('#127 UpdateContractService - reason in deactivated event', () => {
  let csRepo: InMemoryContractServiceRepository;
  let cseRepo: InMemoryContractServiceEventRepository;
  beforeEach(() => {
    csRepo  = new InMemoryContractServiceRepository();
    cseRepo = new InMemoryContractServiceEventRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
  });
  it('deactivated event stores reason when provided', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = new UpdateContractService(csRepo, cseRepo);
    await uc.execute(svc.id, { status: 'inactive' }, { actorId: 'U1', actorName: 'Bob' }, 'cambio de plan');
    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBe('cambio de plan');
  });
  it('deactivated event stores null reason when not provided', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = new UpdateContractService(csRepo, cseRepo);
    await uc.execute(svc.id, { status: 'inactive' }, { actorId: 'U1', actorName: 'Bob' });
    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeNull();
  });
});

describe('#127 RemoveContractService - reason in deactivated event', () => {
  let csRepo: InMemoryContractServiceRepository;
  let cseRepo: InMemoryContractServiceEventRepository;
  beforeEach(() => {
    csRepo  = new InMemoryContractServiceRepository();
    cseRepo = new InMemoryContractServiceEventRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
  });
  it('deactivated event stores reason when provided', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = new RemoveContractService(csRepo, cseRepo);
    await uc.execute(svc.id, { actorId: 'U1', actorName: 'Alice' }, 'vencimiento');
    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('vencimiento');
  });
  it('deactivated event stores null reason when not provided', async () => {
    const svc = await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = new RemoveContractService(csRepo, cseRepo);
    await uc.execute(svc.id, { actorId: null, actorName: 'sys' });
    const events = await cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeNull();
  });
});

describe('#127 CancelTvJobRunner - reason in baja event', () => {
  it('baja event stores reason when runner receives it', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    const result = makeResult({ cic: 'CIC001' });
    const runner = new CancelTvJobRunner(makeCancelTv(result), makeCancelStatus(), eventRepo);
    await runner.run('cust-1', 'contract-99', { actorId: 'U1', actorName: 'Admin' }, 'baja voluntaria');
    const events = eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('baja');
    expect(events[0]!.reason).toBe('baja voluntaria');
  });
  it('baja event stores null reason when not provided', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    const result = makeResult({ cic: 'CIC001' });
    const runner = new CancelTvJobRunner(makeCancelTv(result), makeCancelStatus(), eventRepo);
    await runner.run('cust-1', 'contract-99', { actorId: null, actorName: 'sys' });
    const events = eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeNull();
  });
});

describe('#127 ServiceEventDto - reason field', () => {
  it('tvEventToServiceEvent propagates reason from TV event', () => {
    const tvEvent = { id: 'ev1', eventType: 'baja' as const, cic: 'CIC001',
      actorName: 'admin', createdAt: '2026-07-01T00:00:00.000Z', reason: 'baja voluntaria' };
    const dto = tvEventToServiceEvent(tvEvent);
    expect(dto.reason).toBe('baja voluntaria');
  });
  it('tvEventToServiceEvent sets reason to null when absent', () => {
    const tvEvent = { id: 'ev2', eventType: 'alta' as const, cic: null,
      actorName: 'sys', createdAt: '2026-07-01T00:00:00.000Z' };
    const dto = tvEventToServiceEvent(tvEvent);
    expect(dto.reason).toBeNull();
  });
  it('ListContractServiceHistory - non-TV event exposes reason in DTO', async () => {
    const csRepo  = new InMemoryContractServiceRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
    const cseRepo = new InMemoryContractServiceEventRepository();
    const tvRepo  = new InMemoryTvActivationEventRepository();
    await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    await cseRepo.record({ contractId: 'C', serviceCatalogId: 'S',
      eventType: 'deactivated', actorName: 'ops', reason: 'cambio de plan' });
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvRepo);
    const result = await uc.execute('C');
    expect(result[0]!.events).toHaveLength(1);
    expect(result[0]!.events[0]!.reason).toBe('cambio de plan');
  });
  it('ListContractServiceHistory - legacy synthesized event has reason: null', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    csRepo.catalog['S'] = { name: 'INTERNET', label: null };
    const cseRepo = new InMemoryContractServiceEventRepository();
    const tvRepo  = new InMemoryTvActivationEventRepository();
    await csRepo.add({ contractId: 'C', serviceCatalogId: 'S' });
    const uc = new ListContractServiceHistory(csRepo, cseRepo, tvRepo);
    const result = await uc.execute('C');
    expect(result[0]!.events[0]!.reason).toBeNull();
  });
});
