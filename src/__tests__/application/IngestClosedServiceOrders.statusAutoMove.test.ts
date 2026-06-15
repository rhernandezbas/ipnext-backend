/**
 * iclass-intermediate-states — auto-move tests for IngestClosedServiceOrders.
 *
 * When the captured IClass status CHANGES and its catalog row has a prominenseStageId,
 * the matched task is auto-moved to that stage. Policy "solo avanza" (Stage HAS `order`):
 * the move happens only when the target stage `order` >= the current stage `order`
 * (never retreats; respects a manual advance). Best-effort: a failure never breaks
 * the status capture or the (later) terminal-closure flow.
 */
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';
import { ClosedServiceOrderSummary } from '@domain/entities/iclass-closed-order';
import { Stage } from '@domain/entities/workflow';

// Three stages with strictly increasing `order` so we can exercise the forward-only policy.
const AGENDADA: Stage   = { id: 'st-agendada',   workflowId: 'wf', name: 'Agendada',   code: 'agendada',   category: 'nuevo',      order: 1, color: null };
const EN_CAMINO: Stage  = { id: 'st-en-camino',  workflowId: 'wf', name: 'En camino',  code: 'en_camino',  category: 'enProgreso', order: 5, color: null };
const EJECUCION: Stage   = { id: 'st-ejecucion',  workflowId: 'wf', name: 'Ejecución',  code: 'ejecucion',  category: 'enProgreso', order: 8, color: null };

function makeSummary(over: Partial<ClosedServiceOrderSummary> & Pick<ClosedServiceOrderSummary, 'iclassId' | 'iclassCodigo'>): ClosedServiceOrderSummary {
  return {
    clusterName: 'IPNEXT', thirdPartyCode: null, nodeCode: 'Mercedes', soTypeId: null, soTypeDescription: 'INSTALACION',
    customerCode: '204382', customerName: 'Cliente X', addressCode: '204382', addressLine: 'Calle 1', addressCity: 'Mercedes',
    addressLat: null, addressLng: null, statusCode: '3', statusDescription: 'Agendada',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: null, closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: '2026-05-01T00:00:00.000Z', iclassUpdatedAt: '2026-05-21T17:49:12.000Z',
    rawDetail: {}, ...over,
  };
}

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(AGENDADA);
  stages.addDirect(EN_CAMINO);
  stages.addDirect(EJECUCION);
  const statusCatalog = new InMemoryIClassStatusCatalogRepository();
  const scheduling = new InMemorySchedulingRepository(stages, undefined, statusCatalog);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();

  const now = () => new Date('2026-05-29T12:00:00Z');
  const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now, statusCatalog });

  return { stages, scheduling, iclass, resultCodes, closed, state, statusCatalog, useCase };
}

describe('IngestClosedServiceOrders — status → stage auto-move (iclass-intermediate-states)', () => {
  it('auto-moves the task to prominenseStageId when the status changes and a mapping exists (forward)', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: AGENDADA.id });
    // Map status '5' (En camino) → EN_CAMINO stage (order 5 > current 1 → forward).
    await statusCatalog.upsertByStatusCode({ statusCode: '5', iclassLabel: 'A caminho' });
    await statusCatalog.update('5', { prominenseStageId: EN_CAMINO.id });

    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '5', statusDescription: 'A caminho' })];
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('5');
    expect(task!.stageId).toBe(EN_CAMINO.id); // moved forward
  });

  it('does NOT move when the mapped status has no prominenseStageId (visual-only catalog row)', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: AGENDADA.id });
    // Discovered but not mapped.
    await statusCatalog.upsertByStatusCode({ statusCode: '5', iclassLabel: 'A caminho' });

    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '5', statusDescription: 'A caminho' })];
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(AGENDADA.id); // unchanged
  });

  it('does NOT retreat — target stage with LOWER order than current is ignored (respects manual advance)', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    // Operator manually advanced the task to EJECUCION (order 8).
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: EJECUCION.id });
    // Status maps to EN_CAMINO (order 5 < 8 → would retreat → must be ignored).
    await statusCatalog.upsertByStatusCode({ statusCode: '5', iclassLabel: 'A caminho' });
    await statusCatalog.update('5', { prominenseStageId: EN_CAMINO.id });

    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '5', statusDescription: 'A caminho' })];
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('5'); // status still captured
    expect(task!.stageId).toBe(EJECUCION.id); // NOT moved back
  });

  it('moves when target order EQUALS current order (>= policy, e.g. re-sync of same column)', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: EN_CAMINO.id });
    // Map to another stage with the SAME order as current to exercise the >= boundary.
    const sameOrder: Stage = { id: 'st-same', workflowId: 'wf', name: 'Otra', code: 'otra', category: 'enProgreso', order: 5, color: null };
    (scheduling as unknown as { stageRepo: InMemoryStageRepository }).stageRepo.addDirect(sameOrder);
    await statusCatalog.upsertByStatusCode({ statusCode: '5', iclassLabel: 'A caminho' });
    await statusCatalog.update('5', { prominenseStageId: sameOrder.id });

    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '5', statusDescription: 'A caminho' })];
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(sameOrder.id);
  });

  it('does NOT re-move on an unchanged status (idempotent — only fires on a real status change)', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: AGENDADA.id });
    await statusCatalog.upsertByStatusCode({ statusCode: '5', iclassLabel: 'A caminho' });
    await statusCatalog.update('5', { prominenseStageId: EN_CAMINO.id });
    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '5', statusDescription: 'A caminho' })];

    await useCase.execute(); // first capture → moves to EN_CAMINO

    // Operator manually advances to EJECUCION after the move.
    await scheduling.moveTaskToStage('t1', EJECUCION.id);

    // Second run: same status '5' (no change) → must NOT re-move back to EN_CAMINO.
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.stageId).toBe(EJECUCION.id);
  });

  it('does NOT cross workflows — a mapped stage in a DIFFERENT workflow is ignored even with higher order', async () => {
    const { stages, scheduling, iclass, statusCatalog, useCase } = setup();
    // Task lives in workflow 'wf' (AGENDADA, order 1).
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: AGENDADA.id });
    // The mapped prominenseStageId points at a stage in ANOTHER workflow with a HIGHER order.
    // Stage.order is per-workflow, so a naive order check would wrongly move (and worse, park
    // the task in a stage of a foreign workflow). Must no-op.
    const OTHER_WF_HIGH: Stage = { id: 'st-other-high', workflowId: 'wf-other', name: 'Otro WF', code: 'otro_wf', category: 'enProgreso', order: 50, color: null };
    stages.addDirect(OTHER_WF_HIGH);
    await statusCatalog.upsertByStatusCode({ statusCode: '5', iclassLabel: 'A caminho' });
    await statusCatalog.update('5', { prominenseStageId: OTHER_WF_HIGH.id });

    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '5', statusDescription: 'A caminho' })];
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('5'); // status still captured
    expect(task!.stageId).toBe(AGENDADA.id);  // NOT moved across workflows
  });

  it('best-effort — a move failure does not break the status capture', async () => {
    const { scheduling, iclass, statusCatalog, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: AGENDADA.id });
    await statusCatalog.upsertByStatusCode({ statusCode: '5', iclassLabel: 'A caminho' });
    await statusCatalog.update('5', { prominenseStageId: EN_CAMINO.id });
    // Force the move to throw.
    jest.spyOn(scheduling, 'moveTaskToStageIfForward').mockRejectedValueOnce(new Error('boom'));

    iclass.serviceOrders = [makeSummary({ iclassId: '9001', iclassCodigo: '1001', statusCode: '5', statusDescription: 'A caminho' })];

    const counts = await useCase.execute();
    // Capture still happened; the bad SO was not counted as errored (best-effort swallow).
    expect(counts.skippedNotClosed).toBe(1);
    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('5');
  });
});
