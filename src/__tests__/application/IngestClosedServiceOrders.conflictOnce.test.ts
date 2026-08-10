/**
 * TDD — fix wave W1a / FIX-4(d) — el conflicto de cierre se registra UNA VEZ, cuando la
 * OS pasa a cerrada por PRIMERA vez. No en cada re-ejecución.
 *
 * IClass bumpea `iclassUpdatedAt` de una OS ya ENCERRADA por cosas que no cambian el
 * resultado (aprobación, edición de un comentario, un ajuste de facturación). Cada bump
 * saca a la OS del atajo de idempotencia (`existing.iclassUpdatedAt === s.iclassUpdatedAt`)
 * y la hace recorrer el camino completo: re-mirror, re-move de stage y — antes de este
 * fix — otro `applyTaskClosure`. Si el staff había ganado la carrera con OTRO código, eso
 * escupía un `closure_conflict` NUEVO en cada tick del cron, para siempre. Una discrepancia
 * consultable se convierte en spam consultable, y el feed de actividad de la tarea queda
 * inutilizable.
 *
 * El discriminador de "primera vez" ya existe y no cuesta una query extra: el mirror.
 * `this.closed.upsert(...)` corre DESPUÉS del guard `statusCode !== TERMINAL_STATUS`, así
 * que la sola EXISTENCIA de una fila espejo prueba que esta OS ya fue ingerida estando
 * cerrada. `existing === null` ⇔ es la transición a cerrada.
 *
 * Lo que NO cambia: el cierre en sí se sigue intentando en cada corrida (es idempotente y
 * atómico; si un operador reabrió la tarea, el cron la vuelve a cerrar como antes). Lo
 * único que se suprime en la re-ejecución es el REPORTE de discrepancia.
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

const conflicts = (r: FakeTaskActivityRecorder) => r.calls.filter(c => c.type === 'closure_conflict');

describe('FIX-4(d) — el closure_conflict del ingest se registra UNA sola vez', () => {
  it('un bump de iclassUpdatedAt sobre una OS ya espejada NO vuelve a registrar el conflicto', async () => {
    const { scheduling, iclass, resultCodes, recorder, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    // El staff ya cerró con OTRO resultado: la primera corrida DEBE reportar el conflicto.
    await scheduling.closeTaskIfOpen('t1', { origin: 'staff', resultCode: 'CANCELADO_CLIENTE' });

    await useCase.execute();
    // PRESENCIA antes que AUSENCIA: sin esto, el test pasaría contra un mundo donde el
    // conflicto no se reporta NUNCA (memoria: "probe de ausencia no discrimina").
    expect(conflicts(recorder)).toHaveLength(1);

    // IClass bumpea la OS (aprobación / edición de comentario): mismo estado 7, mismo
    // resultado, otro iclassUpdatedAt → sale del atajo de idempotencia y re-procesa.
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013', iclassUpdatedAt: '2026-05-22T09:00:00.000Z' })];
    await useCase.execute();
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013', iclassUpdatedAt: '2026-05-23T09:00:00.000Z' })];
    await useCase.execute();

    // Sigue habiendo UN conflicto, el de la transición real. No tres.
    expect(conflicts(recorder)).toHaveLength(1);
    // Y el cierre del ganador sigue intacto.
    const task = await scheduling.getTask('t1');
    expect(task!.closureOrigin).toBe('staff');
  });

  it('la supresión NO apaga el cierre: si el operador reabre, un re-ingest la vuelve a cerrar', async () => {
    const { scheduling, iclass, resultCodes, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013' })];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);

    await useCase.execute();
    expect((await scheduling.getTask('t1'))!.generalStatus).toBe('closed');

    await scheduling.updateTask('t1', { generalStatus: 'open' });
    expect((await scheduling.getTask('t1'))!.closureOrigin).toBeNull();

    iclass.serviceOrders = [summary({ iclassId: '900', iclassCodigo: '4013', iclassUpdatedAt: '2026-05-22T09:00:00.000Z' })];
    await useCase.execute();

    const task = await scheduling.getTask('t1');
    expect(task!.generalStatus).toBe('closed');
    expect(task!.closureOrigin).toBe('iclass');
  });

  it('dos OS DISTINTAS en conflicto reportan cada una la suya (la supresión es por OS, no global)', async () => {
    const { scheduling, iclass, resultCodes, recorder, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    scheduling.seedTask({ id: 't2', sequenceNumber: 4014, stageId: REGISTRADO.id });
    iclass.serviceOrders = [
      summary({ iclassId: '900', iclassCodigo: '4013' }),
      summary({ iclassId: '901', iclassCodigo: '4014' }),
    ];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;
    iclass.historyByOrder['901'] = HISTORY_CLOSED;
    await mapResultCode(resultCodes, 'Instalacion Completa Fibra', INSTALADO.id);
    await scheduling.closeTaskIfOpen('t1', { origin: 'staff', resultCode: 'CANCELADO_CLIENTE' });
    await scheduling.closeTaskIfOpen('t2', { origin: 'staff', resultCode: 'OTRO_MOTIVO' });

    await useCase.execute();

    expect(conflicts(recorder).map(c => c.taskId).sort()).toEqual(['t1', 't2']);
  });
});
