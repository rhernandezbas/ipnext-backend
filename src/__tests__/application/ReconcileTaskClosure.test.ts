import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import { ReconcileTaskClosure } from '@application/use-cases/ReconcileTaskClosure';
import { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';
import { Stage } from '@domain/entities/workflow';
import { TaskNotFoundError } from '@domain/errors/scheduling';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

const NOW = new Date('2026-05-29T12:00:00Z');

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

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const ingest = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, { now: () => NOW });
  const backfill = new BackfillClosedServiceOrders(iclass, scheduling, ingest, { now: () => NOW });
  const useCase = new ReconcileTaskClosure(scheduling, backfill);
  return { stages, scheduling, iclass, resultCodes, closed, ingest, backfill, useCase };
}

async function mapResultCode(resultCodes: InMemoryIClassResultCodeRepository) {
  await resultCodes.upsert({ soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' });
  const rc = await resultCodes.findByCode('Instalacion Completa Fibra');
  await resultCodes.assignStage(rc!.id, INSTALADO.id);
}

describe('ReconcileTaskClosure', () => {
  it('reconciles an in-flight task whose SO closed within the lookback window → mirrored/transitioned > 0', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary('900', '4013')];
    iclass.historyByOrder['900'] = HISTORY;
    await mapResultCode(resultCodes);

    const counts = await useCase.execute('t1');

    expect(counts.mirrored).toBe(1);
    expect(counts.transitioned).toBe(1);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(INSTALADO.id);
  });

  it('SO not closed / outside the 29-day window → skippedNotClosed incremented, task untouched', async () => {
    const { scheduling, iclass, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary('900', '4013', '3')]; // still in progress

    const counts = await useCase.execute('t1');

    expect(counts.skippedNotClosed).toBe(1);
    expect(counts.mirrored).toBe(0);
    expect(counts.transitioned).toBe(0);
    expect((await scheduling.getTask('t1'))!.stageId).toBe(REGISTRADO.id);
  });

  it('is idempotent — a re-run returns 200-equivalent (no throw, no duplicate side-effects)', async () => {
    const { scheduling, iclass, resultCodes, closed, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary('900', '4013')];
    iclass.historyByOrder['900'] = HISTORY;
    await mapResultCode(resultCodes);

    await useCase.execute('t1');
    const counts2 = await useCase.execute('t1');

    // No throw; closed-SO store still has exactly one entry (replace-on-rerun, no dup).
    expect(closed.orders.size).toBe(1);
    expect(counts2.failed).toBe(0);
  });

  it('throws TaskNotFoundError when the task does not exist', async () => {
    const { useCase } = setup();
    await expect(useCase.execute('ghost')).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
