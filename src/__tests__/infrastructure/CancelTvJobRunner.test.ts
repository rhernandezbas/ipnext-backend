/**
 * CancelTvJobRunner (#5B) — the baja TvActivationEvent must carry the CIC of the cancelled account.
 *
 * TDD: red → green.
 *
 * Covered:
 *   - On successful cancel, the recorded 'baja' event has `cic` set (from CancelTvResult.cic).
 *   - `contractId` is also forwarded to the event.
 *   - The actor info (actorId / actorName) is threaded correctly.
 *   - On failure ('failed'), NO baja event is recorded (anti-coining guard stays intact).
 *   - When eventRepo is absent, the runner still works (backwards-compat).
 *
 * Regression (alta/reactivacion untouched):
 *   - RegisterGigaredAccount still records 'alta' (seq=0) and 'reactivacion' (seq>0) WITH cic.
 *     Those events are exercised in GigaredAccount.usecases.test.ts — this file adds the
 *     CancelTvJobRunner-specific baja assertions that were missing.
 */

import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import type { CancelTv } from '@application/use-cases/gigared/CancelTv';
import type { ClientTvCancelStatusRepository } from '@domain/ports/ClientTvCancelStatusRepository';
import type { CancelTvResult } from '@application/dto/gigared.dto';

// ---- helpers ----------------------------------------------------------------

function makeResult(over: Partial<CancelTvResult> = {}): CancelTvResult {
  return {
    removed: [],
    failed: [],
    unremovable: [],
    ottDisabled: true,
    local: 'synced',
    renew: { oldCic: '0006230159', newCic: '0006230999' },
    localCancelled: true,
    renewAttempted: true,
    cic: '0006230159',
    ...over,
  };
}

function makeCancelTv(result: CancelTvResult): CancelTv {
  return {
    execute: jest.fn(async () => result),
  } as unknown as CancelTv;
}

function makeCancelStatus(): ClientTvCancelStatusRepository {
  return {
    getStatus: jest.fn(async () => null),
    setStatus: jest.fn(async () => {}),
  };
}

// ---- tests ------------------------------------------------------------------

describe('CancelTvJobRunner (#5B) — baja event carries cic', () => {
  it('on success: records a baja event with cic from result', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    const result = makeResult({ cic: '0006230159' });
    const runner = new CancelTvJobRunner(makeCancelTv(result), makeCancelStatus(), eventRepo);

    await runner.run('cust-1', 'contract-99', { actorId: 'user-1', actorName: 'Operator' });

    const events = eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      clientId: 'cust-1',
      eventType: 'baja',
      cic: '0006230159',
      actorId: 'user-1',
      actorName: 'Operator',
    });
  });

  it('on success: forwards contractId to the baja event', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    const result = makeResult({ cic: '0006230159' });
    const runner = new CancelTvJobRunner(makeCancelTv(result), makeCancelStatus(), eventRepo);

    await runner.run('cust-1', 'contract-99', { actorId: null, actorName: 'System' });

    const events = eventRepo.all();
    expect(events[0]!.contractId).toBe('contract-99');
  });

  it('on failure (cancelTv throws): NO baja event is recorded', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    const cancelTv = { execute: jest.fn(async () => { throw new Error('upstream error'); }) } as unknown as CancelTv;
    const runner = new CancelTvJobRunner(cancelTv, makeCancelStatus(), eventRepo);

    await runner.run('cust-1', 'contract-99');

    expect(eventRepo.all()).toHaveLength(0);
  });

  it('without actor: uses null actorId + empty actorName (default)', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    const result = makeResult({ cic: '0000000042' });
    const runner = new CancelTvJobRunner(makeCancelTv(result), makeCancelStatus(), eventRepo);

    await runner.run('cust-2', 'contract-42');

    const evt = eventRepo.all()[0]!;
    expect(evt.actorId).toBeNull();
    expect(evt.actorName).toBe('');
    expect(evt.cic).toBe('0000000042');
  });

  it('without eventRepo: runner still completes normally (backwards-compat)', async () => {
    const result = makeResult();
    const cancelStatus = makeCancelStatus();
    const runner = new CancelTvJobRunner(makeCancelTv(result), cancelStatus);

    await expect(runner.run('cust-1', 'contract-99')).resolves.toBeUndefined();
    expect(cancelStatus.setStatus).toHaveBeenCalledWith(
      'cust-1',
      expect.objectContaining({ status: 'done' }),
    );
  });
});

describe('RegisterGigaredAccount (#5B regression) — alta/reactivacion still carry cic', () => {
  /**
   * The RegisterGigaredAccount event recording path is already covered in
   * GigaredAccount.usecases.test.ts (see the #92/#5 BE sections). We add a focused
   * smoke test here so this file owns the end-to-end "cic present on every event type" story.
   */
  it('the RegisterGigaredAccount use case records cic on the alta event', async () => {
    const { RegisterGigaredAccount } = await import('@application/use-cases/gigared/RegisterGigaredAccount');
    const eventRepo = new InMemoryTvActivationEventRepository();

    const fakePort = {
      register: jest.fn(async () => {}),
      activate: jest.fn(async () => {}),
      setInternalId: jest.fn(async () => {}),
      getAccountByInternalId: jest.fn(async () => ({
        cic: '0001234567',
        gigaredId: '100',
        email: 'e@x.com',
        firstName: 'N',
        lastName: 'A',
        registrationDate: '2026-01-01',
        services: [{ id: '129', name: 'Gigared Play Full' }],
        internalId: 'cust-1',
        clientId: 'cust-1',
        ott: null,
      })),
      getSummary: jest.fn(),
      listAccounts: jest.fn(),
      getAccountByCic: jest.fn(),
      addService: jest.fn(),
      removeService: jest.fn(),
      setOtt: jest.fn(),
      changePassword: jest.fn(),
      renewCic: jest.fn(),
    };

    const customerLookup = { findById: async (id: string) => ({ id, grClienteId: '243200' }) };
    const uc = new RegisterGigaredAccount(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakePort as any,
      customerLookup,
      undefined, undefined, undefined, undefined, undefined,
      eventRepo,
    );

    await uc.execute('cust-1', {
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'e@x.com',
      cic: '0001234567',
      sendActivationEmail: false,
      actorId: 'user-1',
      actorName: 'Admin',
    });

    const events = eventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'alta',
      cic: '0001234567',
      actorId: 'user-1',
    });
  });
});
