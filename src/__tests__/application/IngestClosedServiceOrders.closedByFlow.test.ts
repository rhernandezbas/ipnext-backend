/**
 * TDD — #41 REQ-GS-ICLASS-CLOSEDBY-FLOW-1.
 *
 * When the IClass closure flow moves a task to a stage whose CATEGORY is 'hecho',
 * the use case MUST also set generalStatus='closed' and emit a `status_changed`
 * activity (actor System / actorId null). Tied to the ACTUAL move event so an
 * operator reopen is never undone by a later reconcile of an UNCHANGED order.
 */
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';
import { Stage } from '@domain/entities/workflow';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };
const POSPUESTA: Stage = { id: 'st-pos', workflowId: 'wf', name: 'Pospuesta', code: 'pospuesta', category: 'enProgreso', order: 6, color: null };

function summary(over: Partial<ClosedServiceOrderSummary> & Pick<ClosedServiceOrderSummary, 'iclassId' | 'iclassCodigo'>): ClosedServiceOrderSummary {
  return {
    clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: 'Mercedes', soTypeId: null, soTypeDescription: 'INSTALACION FIBRA',
    customerCode: '204382', customerName: 'Cliente X', addressCode: '204382', addressLine: 'Calle 1', addressCity: 'Mercedes',
    addressLat: null, addressLng: null, statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Instalacion Completa Fibra', closedByLogin: 'IPNXLUISS', closedByName: 'Luis',
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: 'ok', internalNote: null, commentaryLog: null,
    teamLogin: 'IPNXRODRIGOS', teamTechnicianName: 'Rodrigo', teamPhone: null, teamEmail: null,
    iclassCreatedAt: '2026-05-01T00:00:00.000Z', iclassUpdatedAt: '2026-05-21T17:49:12.000Z',
    rawDetail: {}, ...over,
  };
}

const HISTORY_CLOSED: SoStatusHistoryEntry[] = [
  { iclassOsStatusId: '1', occurredAt: '2026-05-20T10:00:00.000Z', statusCode: '4', statusDescription: 'FECHADA', durationMinutes: 0, teamLogin: 'x', commentary: null },
  { iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
];

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  stages.addDirect(POSPUESTA);
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const recorder = new FakeTaskActivityRecorder();
  const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
    now: () => new Date('2026-05-29T12:00:00Z'),
    recorder,
  });
  return { stages, scheduling, iclass, resultCodes, closed, state, recorder, useCase };
}

async function mapResultCode(resultCodes: InMemoryIClassResultCodeRepository, code: string, stageId: string) {
  await resultCodes.upsert({ soTypeId: '1', code, type: 'Sucesso' });
  const rc = await resultCodes.findByCode(code);
  await resultCodes.assignStage(rc!.id, stageId);
}

describe('IngestClosedServiceOrders — closure flow maps to generalStatus=closed (#41)', () => {
  it('move to hecho-category stage → generalStatus=closed + status_changed (System)', async () => {
    const { scheduling, iclass, resultCodes, recorder, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(INSTALADO.id);
    expect(task!.generalStatus).toBe('closed');
    expect(task!.isClosed).toBe(true);

    const ev = recorder.calls.find(c => c.type === 'status_changed');
    expect(ev).toBeDefined();
    expect(ev!.taskId).toBe('t1');
    expect(ev!.payload.toValue).toBe('closed');
    expect(ev!.payload.actor.actorId).toBeNull();
    expect(ev!.payload.actor.actorName).toBe('System');
  });

  it('move to NON-hecho stage → stays open, no status_changed', async () => {
    const { scheduling, iclass, resultCodes, recorder, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', POSPUESTA.id);

    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(POSPUESTA.id);
    expect(task!.generalStatus).toBe('open');
    expect(recorder.calls.find(c => c.type === 'status_changed')).toBeUndefined();
  });

  it('reopened task already in hecho stage + UNCHANGED order → stays open (no re-close)', async () => {
    const { scheduling, iclass, resultCodes, recorder, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);
    await useCase.execute(); // first run: moves to hecho + closes

    // Operator reopens the task (status back to open). It stays in the hecho stage.
    await scheduling.updateTask('t1', { generalStatus: 'open' });
    const before = recorder.calls.filter(c => c.type === 'status_changed').length;

    await useCase.execute(); // SO unchanged → reconcile path, NOT a fresh move

    const task = await scheduling.getTask('t1');
    expect(task!.generalStatus).toBe('open'); // reopen NOT undone
    const after = recorder.calls.filter(c => c.type === 'status_changed').length;
    expect(after).toBe(before); // no new status_changed emitted
  });

  it('dismissed task mapping to hecho stage → stays dismissed (guard ordering)', async () => {
    const { scheduling, iclass, resultCodes, recorder, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, generalStatus: 'dismissed', isClosed: false });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.generalStatus).toBe('dismissed'); // dismissed bail wins
    expect(task!.stageId).toBe(REGISTRADO.id); // no stage move either
    expect(recorder.calls.find(c => c.type === 'status_changed')).toBeUndefined();
  });
});
