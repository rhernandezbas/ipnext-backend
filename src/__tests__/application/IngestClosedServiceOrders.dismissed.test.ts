/**
 * TDD — #41 IngestClosedServiceOrders skips task side-effects for dismissed tasks.
 *
 * REQ-GS-ICLASS-INGEST-1: a dismissed task still gets its IClass SO mirrored, but
 * NO stage transition, NO side-effects, and (unchanged path) NO reconcile. The SO
 * is counted as `skippedDismissed`. Non-dismissed tasks proceed normally.
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

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

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
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z') });
  return { stages, scheduling, iclass, resultCodes, closed, state, useCase };
}

async function mapResultCode(resultCodes: InMemoryIClassResultCodeRepository, code: string, stageId: string) {
  await resultCodes.upsert({ soTypeId: '1', code, type: 'Sucesso' });
  const rc = await resultCodes.findByCode(code);
  await resultCodes.assignStage(rc!.id, stageId);
}

describe('IngestClosedServiceOrders — dismissed tasks (#41)', () => {
  it('mirrors the SO but skips stage move + counts skippedDismissed (fresh path)', async () => {
    const { scheduling, iclass, resultCodes, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, generalStatus: 'dismissed', isClosed: false });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    const counts = await useCase.execute();

    // Mirror IS ingested (audit trail preserved).
    expect(closed.orders.get('900')!.scheduledTaskId).toBe('t1');
    expect(counts.mirrored).toBe(1);
    // No stage transition for a dismissed task.
    expect(counts.transitioned).toBe(0);
    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(REGISTRADO.id); // unchanged
    // Counted as skippedDismissed.
    expect(counts.skippedDismissed).toBe(1);
  });

  it('unchanged path: dismissed task is NOT reconciled, counted skippedDismissed', async () => {
    const { scheduling, iclass, resultCodes, closed, useCase } = setup();
    // Seed as OPEN first so the first run mirrors + transitions normally.
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);
    await useCase.execute(); // first run: mirror + transition

    // Now the operator dismisses the task and moves it back to REGISTRADO manually.
    await scheduling.updateTask('t1', { generalStatus: 'dismissed' });
    await scheduling.moveTaskToStage('t1', REGISTRADO.id);

    const second = await useCase.execute(); // SO unchanged → unchanged path

    // Dismissed → no reconcile back to INSTALADO; counted skippedDismissed not skippedUnchanged.
    expect(second.skippedDismissed).toBe(1);
    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(REGISTRADO.id); // not reconciled away
  });

  it('open task proceeds normally (control — no skippedDismissed)', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    const counts = await useCase.execute();

    expect(counts.transitioned).toBe(1);
    expect(counts.skippedDismissed).toBe(0);
    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(INSTALADO.id);
  });

  // F1 — runClosureSideEffects is the choke point: ANY caller (including the manual
  // reprocess via the cron) that re-fires side-effects on a dismissed task must SKIP
  // ALL effects (no comment, no inventory, no audit). The G1/G2 ingest guards only
  // cover processSummary; the contaminating path is runClosureSideEffects directly.
  it('runClosureSideEffects skips ALL effects for a dismissed task (choke point)', async () => {
    const { scheduling, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, generalStatus: 'dismissed', isClosed: false });

    const postComment = { execute: jest.fn(async () => undefined) };
    const buildSuggestions = { execute: jest.fn(async () => undefined) };
    const auditInstallation = { execute: jest.fn(async () => ({ ok: true })) };
    // Reconstruct the use case with side-effect runners wired so we can prove none fire.
    const iclass2 = new InMemoryIClassClient();
    const resultCodes2 = new InMemoryIClassResultCodeRepository();
    const state2 = new InMemorySyncStateRepository();
    const uc = new IngestClosedServiceOrders(iclass2, closed, resultCodes2, scheduling, state2, {
      now: () => new Date('2026-05-29T12:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postComment: postComment as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildSuggestions: buildSuggestions as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      auditInstallation: auditInstallation as any,
    });

    const order = {
      ...summary({ iclassId: '900', iclassCodigo: '4013' }),
      closedAt: null, firstClosedAt: null, approvedAt: null, resultCodeType: null,
      history: [], checklists: [], materials: [], equipmentEvents: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await uc.runClosureSideEffects(order, 't1');

    expect(postComment.execute).not.toHaveBeenCalled();
    expect(buildSuggestions.execute).not.toHaveBeenCalled();
    expect(auditInstallation.execute).not.toHaveBeenCalled();
    // Unused var ref to keep useCase referenced (control instance from setup).
    expect(typeof useCase.execute).toBe('function');
  });
});
