/**
 * TDD — TV activation event recording (#5 BE).
 *
 * RegisterGigaredAccount: records 'alta' (seq=0) / 'reactivacion' (seq>0) best-effort.
 * CancelTvJobRunner: records 'baja' when cancel finishes 'done' with actor threaded from route.
 * Best-effort: recorder throw does not abort the main operation.
 */
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import { CancelTv } from '@application/use-cases/gigared/CancelTv';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryClientTvActivationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository';
import { InMemoryClientTvCancelStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancelStatusRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { CancelTvResult } from '@application/dto/gigared.dto';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'cust-1', clientId: 'cust-1', ott: null,
    ...over,
  };
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 1, unregistered: 2, total: 3 }, services: [] })),
    listAccounts: jest.fn(async () => [fakeAccount()]),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount({ internalId: null })),
    register: jest.fn(async () => {}),
    activate: jest.fn(async () => {}),
    setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' })),
    ...over,
  };
}

const customerLookup = (exists: boolean, grClienteId = '243200') => ({
  findById: async (id: string) => (exists ? { id, grClienteId } : null),
});

const contractLookup = (owner = 'cust-1') => ({
  findById: async (id: string) => ({ id, clientId: owner }),
});

// ─── RegisterGigaredAccount event recording ─────────────────────────────────

describe('RegisterGigaredAccount — records alta event (seq=0)', () => {
  it('records eventType=alta with actorId, actorName, cic, internalId, seq=0, contractId', async () => {
    const port = fakePort();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const tvActivation = new InMemoryClientTvActivationRepository();
    const eventRepo = new InMemoryTvActivationEventRepository();

    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), contractLookup(), undefined, undefined, tvCancellation, tvActivation,
      eventRepo,
    );

    await uc.execute('cust-1', {
      firstName: 'John', lastName: 'Doe', email: 'j@x.com', cic: '0000000001',
      sendActivationEmail: false, contractId: undefined,
      actorId: 'actor-1', actorName: 'Operator One',
    });

    const events = eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      clientId:  'cust-1',
      actorId:   'actor-1',
      actorName: 'Operator One',
      eventType: 'alta',
      seq:       0,
    });
  });

  it('records eventType=reactivacion when seq>0 (client was cancelled, re-alta)', async () => {
    const port = fakePort();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    // mark the client as cancelled so seq will be incremented
    await tvCancellation.markCancelled('cust-1');
    const tvActivation = new InMemoryClientTvActivationRepository();
    const eventRepo = new InMemoryTvActivationEventRepository();

    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), contractLookup(), undefined, undefined, tvCancellation, tvActivation,
      eventRepo,
    );

    await uc.execute('cust-1', {
      firstName: 'John', lastName: 'Doe', email: 'j@x.com', cic: '0000000001',
      sendActivationEmail: false,
      actorId: 'actor-2', actorName: 'Operator Two',
    });

    const events = eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'reactivacion',
      actorId:   'actor-2',
      actorName: 'Operator Two',
    });
    expect(events[0]!.seq).toBeGreaterThan(0);
  });

  it('records cic and internalId from the registration input', async () => {
    const port = fakePort();
    const eventRepo = new InMemoryTvActivationEventRepository();

    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), undefined, undefined, undefined,
      undefined, undefined, eventRepo,
    );

    await uc.execute('cust-1', {
      firstName: 'A', lastName: 'B', email: 'a@b.com', cic: '0000000007',
      sendActivationEmail: false, actorId: null, actorName: 'System',
    });

    const events = eventRepo.all();
    expect(events[0]).toMatchObject({ cic: '0000000007', internalId: 'cust-1' });
  });

  it('best-effort: recorder throws but register still succeeds', async () => {
    const port = fakePort();
    const throwingRepo = {
      record: jest.fn(async () => { throw new Error('DB down'); }),
      listByClient: jest.fn(async () => []),
      list: jest.fn(async () => []),
      listByContract: jest.fn(async () => []),
    };

    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), undefined, undefined, undefined,
      undefined, undefined, throwingRepo,
    );

    await expect(uc.execute('cust-1', {
      firstName: 'A', lastName: 'B', email: 'a@b.com', cic: '0000000001',
      sendActivationEmail: false, actorId: null, actorName: 'S',
    })).resolves.toBeDefined(); // does not throw

    expect(port.register).toHaveBeenCalled();
  });
});

// ─── CancelTvJobRunner — records baja event ──────────────────────────────────

describe('CancelTvJobRunner — records baja event on done', () => {
  const doneResult: CancelTvResult = {
    removed: ['129'], failed: [], unremovable: [], ottDisabled: true,
    local: 'synced', renew: { oldCic: '0000000001', newCic: '0000000002' },
    localCancelled: true, renewAttempted: true, cic: '0000000001',
  };

  function makeCancelTv(result: CancelTvResult): CancelTv {
    return { execute: jest.fn(async () => result) } as unknown as CancelTv;
  }

  function makeThrowingCancelTv(msg: string): CancelTv {
    return { execute: jest.fn(async () => { throw new Error(msg); }) } as unknown as CancelTv;
  }

  it('records baja event with actorId and actorName when cancel succeeds', async () => {
    const cancelTv = makeCancelTv(doneResult);
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const eventRepo = new InMemoryTvActivationEventRepository();

    const runner = new CancelTvJobRunner(cancelTv, cancelStatus, eventRepo);
    await runner.run('cust-1', 'C1', { actorId: 'actor-1', actorName: 'Operator One' });

    const events = eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      clientId:  'cust-1',
      actorId:   'actor-1',
      actorName: 'Operator One',
      eventType: 'baja',
    });
  });

  it('does NOT record baja when cancel fails (throws)', async () => {
    const cancelTv = makeThrowingCancelTv('upstream error');
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const eventRepo = new InMemoryTvActivationEventRepository();

    const runner = new CancelTvJobRunner(cancelTv, cancelStatus, eventRepo);
    await runner.run('cust-1', 'C1', { actorId: 'actor-1', actorName: 'Op' });

    const events = eventRepo.all();
    expect(events).toHaveLength(0); // no event recorded on failure

    const status = await cancelStatus.getStatus('cust-1');
    expect(status?.status).toBe('failed'); // runner still writes status
  });

  it('runner still writes done/failed status even when baja event recorder throws', async () => {
    const cancelTv = makeCancelTv(doneResult);
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const throwingEventRepo = {
      record: jest.fn(async () => { throw new Error('event DB down'); }),
      listByClient: jest.fn(async () => []),
      list: jest.fn(async () => []),
      listByContract: jest.fn(async () => []),
    };

    const runner = new CancelTvJobRunner(cancelTv, cancelStatus, throwingEventRepo);
    await runner.run('cust-1', 'C1', { actorId: 'a1', actorName: 'Op' });

    // Even with the event repo throwing, the cancel status is written
    const status = await cancelStatus.getStatus('cust-1');
    expect(status?.status).toBe('done');
  });

  it('works without eventRepo (backwards compat — no eventRepo passed)', async () => {
    const cancelTv = makeCancelTv(doneResult);
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();

    // No eventRepo — old signature
    const runner = new CancelTvJobRunner(cancelTv, cancelStatus);
    await expect(runner.run('cust-1', 'C1')).resolves.toBeUndefined();

    const status = await cancelStatus.getStatus('cust-1');
    expect(status?.status).toBe('done');
  });

  it('works without actor in run() call', async () => {
    const cancelTv = makeCancelTv(doneResult);
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const eventRepo = new InMemoryTvActivationEventRepository();

    const runner = new CancelTvJobRunner(cancelTv, cancelStatus, eventRepo);
    await runner.run('cust-1', 'C1'); // no actor

    const events = eventRepo.all();
    // Event should still be recorded with null actorId
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'baja', actorId: null, actorName: '' });
  });
});
