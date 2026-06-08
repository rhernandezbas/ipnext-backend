import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';
import { Stage } from '@domain/entities/workflow';
import { IClassPort } from '@domain/ports/IClassPort';
import { IClassUnavailableError } from '@domain/errors/iclass';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

const HISTORY: SoStatusHistoryEntry[] = [
  { iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
];

function summary(iclassId: string, codigo: string, statusCode = '7'): ClosedServiceOrderSummary {
  return {
    iclassId, iclassCodigo: codigo, clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: null,
    soTypeId: null, soTypeDescription: null, customerCode: null, customerName: null, addressCode: null, addressLine: null,
    addressCity: null, addressLat: null, addressLng: null, statusCode, statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Instalacion Completa Fibra', closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: null,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: '2026-05-21T17:49:12.000Z', rawDetail: {},
  };
}

function setup(opts?: { inFlightStageCode?: string }) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const ingest = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z') });
  const backfill = new BackfillClosedServiceOrders(iclass, scheduling, ingest, {
    now: () => new Date('2026-05-29T12:00:00Z'),
    ...(opts?.inFlightStageCode !== undefined && { inFlightStageCode: opts.inFlightStageCode }),
  });
  return { stages, scheduling, iclass, resultCodes, closed, ingest, backfill };
}

describe('BackfillClosedServiceOrders', () => {
  it('reconciles each in-flight task by its serviceOrderCode and closes the loop', async () => {
    const { scheduling, iclass, resultCodes, closed, backfill } = setup();
    // two tasks awaiting closure (in Registrado en IClass)
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4014, stageId: REGISTRADO.id });
    // one already-done task in another stage (must be ignored)
    scheduling.seedTask({ id: 't3', sequenceNumber: 9999, stageId: INSTALADO.id });
    // iclass has closed SOs for both in-flight tasks
    iclass.serviceOrders = [summary('900', '4013'), summary('901', '4014')];
    iclass.historyByOrder['900'] = HISTORY;
    iclass.historyByOrder['901'] = HISTORY;
    await resultCodes.upsert({ soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' });
    const rc = await resultCodes.findByCode('Instalacion Completa Fibra');
    await resultCodes.assignStage(rc!.id, INSTALADO.id);

    const counts = await backfill.execute();

    expect(counts.mirrored).toBe(2);
    expect(counts.transitioned).toBe(2);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(INSTALADO.id);
    expect((await scheduling.getTask('t2'))!.stageId).toBe(INSTALADO.id);
    expect(closed.orders.size).toBe(2);
  });

  it('queries IClass by the exact serviceOrderCode of each in-flight task', async () => {
    const { scheduling, iclass, backfill } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary('900', '4013')];

    await backfill.execute();

    expect(iclass.listCalls.map(c => c.serviceOrderCode)).toEqual(['4013']);
  });

  it('does nothing when there are no in-flight tasks', async () => {
    const { backfill } = setup();
    const counts = await backfill.execute();
    expect(counts.mirrored).toBe(0);
    expect(counts.transitioned).toBe(0);
  });

  it('leaves a task untouched when its SO is not yet closed', async () => {
    const { scheduling, iclass, backfill, closed } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary('900', '4013', '3')]; // still in progress

    const counts = await backfill.execute();
    expect(counts.skippedNotClosed).toBe(1);
    expect(counts.mirrored).toBe(0);
    expect(closed.orders.size).toBe(0);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(REGISTRADO.id);
  });

  // ── Phase 3: per-task isolation + throttle (REQ-TASK-ISOLATION-1, REQ-THROTTLE-1) ─────

  /**
   * Fake IClass client that throws on specific serviceOrderCodes.
   * Other tasks succeed (return empty list).
   */
  function makeFaultyIClass(throwOnCodes: string[]): IClassPort {
    return {
      listServiceOrders: async (params: { serviceOrderCode?: string; updatedDateBegin: Date; updatedDateEnd: Date }) => {
        if (params.serviceOrderCode && throwOnCodes.includes(params.serviceOrderCode)) {
          throw new IClassUnavailableError('IClass down for task');
        }
        return [];
      },
    } as unknown as IClassPort;
  }

  function setupIsolation(opts?: { inFlightStageCode?: string }) {
    const stages = new InMemoryStageRepository();
    stages.addDirect(REGISTRADO);
    stages.addDirect(INSTALADO);
    const scheduling = new InMemorySchedulingRepository(stages);
    const resultCodes = new InMemoryIClassResultCodeRepository();
    const closed = new InMemoryClosedServiceOrderRepository();
    const state = new InMemorySyncStateRepository();
    // iclass is passed externally per test
    return { stages, scheduling, resultCodes, closed, state };
  }

  function makeBackfill(
    iclass: IClassPort,
    scheduling: InMemorySchedulingRepository,
    resultCodes: InMemoryIClassResultCodeRepository,
    closed: InMemoryClosedServiceOrderRepository,
    state: InMemorySyncStateRepository,
    opts: { throttleMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    const ingest = new IngestClosedServiceOrders(iclass as any, closed, resultCodes, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z') });
    return new BackfillClosedServiceOrders(iclass as any, scheduling, ingest, {
      now: () => new Date('2026-05-29T12:00:00Z'),
      throttleMs: opts.throttleMs ?? 0,
      ...(opts.sleep !== undefined && { _sleep: opts.sleep }),
    });
  }

  // ── Task 3.1: task 2 throws → tasks 1 and 3 process normally, failed=1 ───

  it('3.1: task 2 throws → tasks 1 and 3 process normally, failed=1, no batch throw (REQ-TASK-ISOLATION-1)', async () => {
    const { scheduling, resultCodes, closed, state } = setupIsolation();
    // Tasks 1, 2, 3 all in-flight
    scheduling.seedTask({ id: 't1', sequenceNumber: 4001, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4002, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't3', sequenceNumber: 4003, stageId: REGISTRADO.id });

    // task 2 (code '4002') throws; tasks 1 and 3 succeed with empty SO lists
    const iclass = makeFaultyIClass(['4002']);

    const backfill = makeBackfill(iclass, scheduling, resultCodes, closed, state);
    const counts = await backfill.execute();

    expect(counts.failed).toBe(1);
    // Tasks 1 and 3 were processed (no throw)
    // With empty SO lists → 0 mirrored, but no throw
    expect(counts.mirrored).toBe(0);
    // Batch itself did not throw (execute resolved)
  });

  // ── Task 3.2: all tasks succeed → failed=0 ───────────────────────────────

  it('3.2: all tasks succeed → failed=0 (REQ-TASK-ISOLATION-1)', async () => {
    const { scheduling, resultCodes, closed, state } = setupIsolation();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4001, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4002, stageId: REGISTRADO.id });

    const iclass = new InMemoryIClassClient(); // no failures
    const backfill = makeBackfill(iclass, scheduling, resultCodes, closed, state);

    const counts = await backfill.execute();

    expect(counts.failed).toBe(0);
  });

  // ── Task 3.3: all tasks throw → no batch throw, failed = task count ──────

  it('3.3: all tasks throw → no batch throw, failed equals task count (REQ-TASK-ISOLATION-1)', async () => {
    const { scheduling, resultCodes, closed, state } = setupIsolation();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4001, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4002, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't3', sequenceNumber: 4003, stageId: REGISTRADO.id });

    const iclass = makeFaultyIClass(['4001', '4002', '4003']);
    const backfill = makeBackfill(iclass, scheduling, resultCodes, closed, state);

    const counts = await backfill.execute();

    // No throw from execute()
    expect(counts.failed).toBe(3);
    expect(counts.mirrored).toBe(0);
    expect(counts.transitioned).toBe(0);
  });

  // ── Task 3.4: sleep spy called exactly N times for 3-task run ────────────

  it('3.4: sleep spy called exactly 3 times for a 3-task run (after each task, REQ-THROTTLE-1)', async () => {
    const { scheduling, resultCodes, closed, state } = setupIsolation();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4001, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4002, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't3', sequenceNumber: 4003, stageId: REGISTRADO.id });

    const sleepCalls: number[] = [];
    const fakeSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };

    const iclass = new InMemoryIClassClient();
    const backfill = makeBackfill(iclass, scheduling, resultCodes, closed, state, {
      throttleMs: 50,
      sleep: fakeSleep,
    });

    await backfill.execute();

    // The throttle sleeps once after EACH task (unconditional, inside the loop),
    // so a 3-task run sleeps exactly 3 times.
    expect(sleepCalls.length).toBe(3);
    // All calls received the throttleMs value
    expect(sleepCalls.every(ms => ms === 50)).toBe(true);
  });

  // ── Task 3.5: throttleMs=0 → test completes without real delays ──────────

  it('3.5: throttleMs=0 → execute completes without real delays (REQ-THROTTLE-1)', async () => {
    const { scheduling, resultCodes, closed, state } = setupIsolation();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4001, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4002, stageId: REGISTRADO.id });

    const iclass = new InMemoryIClassClient();
    const backfill = makeBackfill(iclass, scheduling, resultCodes, closed, state, { throttleMs: 0 });

    const start = Date.now();
    await backfill.execute();
    const elapsed = Date.now() - start;

    // With throttleMs=0 and in-memory iclass, should finish in < 500ms
    expect(elapsed).toBeLessThan(500);
    // And no failures
    expect((await backfill.execute()).failed).toBe(0);
  });

  it('accepts inFlightStageCode option (rename-safe, REQ-BACKFILL-STAGE-1)', async () => {
    // When the stage has a different name but same code, passing inFlightStageCode
    // must still find the tasks.
    const { scheduling, iclass, resultCodes, closed, backfill } = setup({ inFlightStageCode: 'registered_in_iclass' });
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary('900', '4013')];
    iclass.historyByOrder['900'] = [
      { iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
    ];
    await resultCodes.upsert({ soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' });
    const rc = await resultCodes.findByCode('Instalacion Completa Fibra');
    await resultCodes.assignStage(rc!.id, INSTALADO.id);

    const counts = await backfill.execute();

    expect(counts.mirrored).toBe(1);
    expect(counts.transitioned).toBe(1);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(INSTALADO.id);
  });
});
