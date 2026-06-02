import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { IClassClosureScheduler } from '@infrastructure/scheduling/IClassClosureScheduler';
import { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';
import { Stage } from '@domain/entities/workflow';

const FLAG = 'iclass-closure-loop';
const REG: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INST: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };
const HISTORY: SoStatusHistoryEntry[] = [{ iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: null, commentary: null }];

function so(): ClosedServiceOrderSummary {
  return {
    iclassId: '900', iclassCodigo: '4013', clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: null,
    soTypeDescription: null, customerCode: null, customerName: null, addressCode: null, addressLine: null, addressCity: null,
    addressLat: null, addressLng: null, statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'OK', closedByLogin: null, closedByName: null, closeLatitude: null, closeLongitude: null, closeGpsAt: null,
    billingAmount: null, technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: '2026-05-21T17:49:12.000Z', rawDetail: {},
  };
}

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REG);
  stages.addDirect(INST);
  const scheduling = new InMemorySchedulingRepository(stages);
  scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REG.id });
  const iclass = new InMemoryIClassClient();
  iclass.serviceOrders = [so()];
  iclass.historyByOrder['900'] = HISTORY;
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const flags = new InMemoryFeatureFlagRepository();
  const lock = new InMemoryDistributedLock();
  const ingest = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z') });
  const scheduler = new IClassClosureScheduler(ingest, flags, { intervalMs: 1000, silent: true }, lock);
  return { scheduler, flags, closed, lock };
}

describe('IClassClosureScheduler', () => {
  it('skips when the feature flag is OFF', async () => {
    const { scheduler, closed } = setup();
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBe(true);
    expect(closed.orders.size).toBe(0);
  });

  it('runs the ingest when the flag is ON', async () => {
    const { scheduler, flags, closed } = setup();
    flags.seed(FLAG, true);
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBeUndefined();
    expect(summary.counts?.mirrored).toBe(1);
    expect(closed.orders.size).toBe(1);
  });

  it('skips when the distributed lock is held elsewhere', async () => {
    const { scheduler, flags, lock, closed } = setup();
    flags.seed(FLAG, true);
    lock.forceAcquireFails = true;
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBe(true);
    expect(closed.orders.size).toBe(0);
  });

  it('releases the lock after a run', async () => {
    const { scheduler, flags, lock } = setup();
    flags.seed(FLAG, true);
    await scheduler.runOnce();
    expect(lock.heldKeys.has('iclass-closed')).toBe(false);
  });
});
