/**
 * TDD — fix wave 2 W1a / FIX-A — una FILA LEGACY no es un conflicto.
 *
 * FIX-4 dejó una asimetría deliberada: "perdedor CON código sobre ganador SIN código
 * SÍ es discrepancia". Correcta para el mundo POST-migración, donde un ganador sin
 * `closureResultCode` es alguien que efectivamente cerró sin dejar resultado.
 *
 * Pero `closureOrigin`/`closureResultCode` son columnas NUEVAS y sin backfill (el spec
 * lo fija: "las tareas cerradas ANTES de esta migración quedan con closureOrigin=null").
 * Una tarea cerrada hace meses vuelve del guard con `existingOrigin === null` Y
 * `existingResultCode === null`: eso NO es "un ganador que cerró sin resultado", es
 * "no hay dato". El primer ingest que toque cualquiera de esas OS históricas — el
 * backfill, justamente — dispararía un `closure_conflict` por CADA una, inventando
 * discrepancias contra un ganador que nunca existió.
 *
 * Discriminador (el ÚNICO cambio respecto de FIX-4):
 *   existingOrigin === null && existingResultCode === null → fila legacy → SILENCIO
 *   existingOrigin !== null && existingResultCode === null → ganador post-migración
 *                                                            sin resultado → CONFLICTO
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { applyTaskClosure } from '@application/use-cases/applyTaskClosure';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';
import { Stage } from '@domain/entities/workflow';
import { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';

const conflicts = (r: FakeTaskActivityRecorder) => r.calls.filter(c => c.type === 'closure_conflict');
const loggedConflict = (s: jest.SpyInstance) =>
  s.mock.calls.some(c => typeof c[0] === 'string' && c[0].includes('[task-closure-conflict]'));

function harness() {
  const repo = new InMemorySchedulingRepository();
  const recorder = new FakeTaskActivityRecorder();
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  return { repo, recorder, logSpy };
}

afterEach(() => jest.restoreAllMocks());

describe('FIX-A — ganador sin origen NI resultado (fila legacy) → sin log, sin activity', () => {
  it('tarea cerrada PRE-migración (closureOrigin=null, closureResultCode=null): el perdedor con código NO reporta', async () => {
    const { repo, recorder, logSpy } = harness();
    // seedTask cerrada SIN closureOrigin = exactamente la fila que dejó la migración:
    // generalStatus='closed' con las cuatro columnas de cierre en null.
    repo.seedTask({ id: 'legacy-1', generalStatus: 'closed', isClosed: true });
    expect(repo.getClosureDetails('legacy-1')?.resultCode ?? null).toBeNull(); // presencia antes que ausencia

    const result = await applyTaskClosure(repo, recorder, {
      taskId: 'legacy-1',
      origin: 'iclass',
      resultCode: 'Instalacion Completa Fibra',
    });

    expect(result.closed).toBe(false);
    expect(result.existingOrigin).toBeNull();
    expect(result.existingResultCode).toBeNull();
    expect(conflicts(recorder)).toHaveLength(0);
    expect(loggedConflict(logSpy)).toBe(false);
  });

  it('CONTRASTE (la asimetría de FIX-4 SIGUE viva): ganador POST-migración con origen y SIN resultado → SÍ reporta', async () => {
    const { repo, recorder, logSpy } = harness();
    repo.seedTask({ id: 't-1', generalStatus: 'open', isClosed: false });
    // Cierre real por el guard: deja closureOrigin='staff' y closureResultCode=null.
    await applyTaskClosure(repo, recorder, { taskId: 't-1', origin: 'staff', resultCode: null });
    recorder.calls.length = 0;
    logSpy.mockClear();

    const result = await applyTaskClosure(repo, recorder, {
      taskId: 't-1',
      origin: 'iclass',
      resultCode: 'REAGENDADO',
    });

    expect(result.existingOrigin).toBe('staff'); // ← lo que distingue esta fila de la legacy
    expect(result.existingResultCode).toBeNull();
    expect(conflicts(recorder)).toHaveLength(1);
    expect(conflicts(recorder)[0]!.payload.metadata).toEqual({
      winnerOrigin: 'staff',
      winnerResultCode: null,
      loserOrigin: 'iclass',
      loserResultCode: 'REAGENDADO',
    });
    expect(loggedConflict(logSpy)).toBe(true);
  });
});

// ── El escenario que motiva el fix: el backfill histórico ────────────────────────

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

const HISTORY_CLOSED: SoStatusHistoryEntry[] = [
  { iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
];

function ingestSummary(): ClosedServiceOrderSummary {
  return {
    iclassId: '900', iclassCodigo: '4013',
    clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: 'Mercedes', soTypeId: null, soTypeDescription: 'INSTALACION FIBRA',
    customerCode: '204382', customerName: 'Cliente X', addressCode: '204382', addressLine: 'Calle 1', addressCity: 'Mercedes',
    addressLat: null, addressLng: null, statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Instalacion Completa Fibra', closedByLogin: 'IPNXLUISS', closedByName: 'Luis',
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: 'ok', internalNote: null, commentaryLog: null,
    teamLogin: 'IPNXRODRIGOS', teamTechnicianName: 'Rodrigo', teamPhone: null, teamEmail: null,
    iclassCreatedAt: '2026-05-01T00:00:00.000Z', iclassUpdatedAt: '2026-05-21T17:49:12.000Z',
    rawDetail: {},
  };
}

describe('FIX-A — backfill histórico: la PRIMERA ingesta de una OS con tarea cerrada hace meses no inventa conflictos', () => {
  it('CERO activities: ni closure_conflict ni status_changed (la tarea legacy ya estaba cerrada)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stages = new InMemoryStageRepository();
    stages.addDirect(REGISTRADO);
    stages.addDirect(INSTALADO);
    const scheduling = new InMemorySchedulingRepository(stages);
    const iclass = new InMemoryIClassClient();
    const resultCodes = new InMemoryIClassResultCodeRepository();
    const closed = new InMemoryClosedServiceOrderRepository();
    const state = new InMemorySyncStateRepository();
    const recorder = new FakeTaskActivityRecorder();

    // La tarea histórica: cerrada antes de la migración → las cuatro columnas en null.
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, generalStatus: 'closed', isClosed: true });
    iclass.serviceOrders = [ingestSummary()];
    iclass.historyByOrder['900'] = HISTORY_CLOSED;

    await resultCodes.upsert({ soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' });
    const rc = await resultCodes.findByCode('Instalacion Completa Fibra');
    await resultCodes.assignStage(rc!.id, INSTALADO.id);

    const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
      now: () => new Date('2026-05-29T12:00:00Z'),
      recorder,
    });

    const counts = await useCase.execute();

    expect(counts.mirrored).toBe(1); // presencia: el espejo SÍ se escribió (el flujo corrió de verdad)
    expect(recorder.calls).toHaveLength(0);
    expect(recorder.manyCalls).toHaveLength(0);
    expect(loggedConflict(logSpy)).toBe(false);
  });
});
