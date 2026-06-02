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

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

const HISTORY: SoStatusHistoryEntry[] = [
  { iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
];

function summary(iclassId: string, codigo: string, statusCode = '7'): ClosedServiceOrderSummary {
  return {
    iclassId, iclassCodigo: codigo, clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: null,
    soTypeDescription: null, customerCode: null, customerName: null, addressCode: null, addressLine: null,
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
