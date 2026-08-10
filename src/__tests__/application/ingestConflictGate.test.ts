/**
 * TDD — fix wave 2 W1a / FIX-B — el gate del reporte cuelga del INTENTO DE CIERRE,
 * no de la existencia del espejo.
 *
 * FIX-4(d) puso `reportConflict: existing === null` para no re-loguear la misma
 * discrepancia en cada tick (IClass bumpea `iclassUpdatedAt` de OS ya cerradas). La
 * INTENCIÓN es correcta: reportar sólo en el primer intento de cierre. El PROXY es el
 * que está mal: `existing` dice "esta OS ya estaba espejada", y el espejo se upsertea
 * ANTES de dos bails que se saltean el cierre entero —
 *
 *   1. `isDismissed` → mirror + `return` (ningún cierre)
 *   2. `rc?.mappedStageId` ausente (código de resultado sin mapear) → no hay move, no
 *      hay cierre
 *
 * — con lo cual la PRIMERA ingesta puede dejar el espejo escrito SIN haber intentado
 * cerrar nunca. Cuando el operador mapea el código y la segunda corrida por fin llega
 * al cierre, `existing !== null` y la discrepancia — la primera y única — se descarta
 * en silencio. Es el caso más probable de todos: mapear el código DESPUÉS es el flujo
 * normal de configuración.
 *
 * El discriminador honesto es un dato propio: `closureAttemptedAt` en el espejo, escrito
 * junto al cierre. `null` ⇔ nunca se intentó ⇔ reportá.
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
import { ScheduledTask } from '@domain/entities/scheduling';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

const HISTORY_CLOSED: SoStatusHistoryEntry[] = [
  { iclassOsStatusId: '2', occurredAt: '2026-05-21T17:49:11.000Z', statusCode: '7', statusDescription: 'ENCERRADO', durationMinutes: 0, teamLogin: 'x', commentary: null },
];

const RESULT_CODE = 'Instalacion Completa Fibra';

function summary(overrides: Partial<ClosedServiceOrderSummary> = {}): ClosedServiceOrderSummary {
  return {
    iclassId: '900', iclassCodigo: '4013',
    clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: 'Mercedes', soTypeId: null, soTypeDescription: 'INSTALACION FIBRA',
    customerCode: '204382', customerName: 'Cliente X', addressCode: '204382', addressLine: 'Calle 1', addressCity: 'Mercedes',
    addressLat: null, addressLng: null, statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: RESULT_CODE, closedByLogin: 'IPNXLUISS', closedByName: 'Luis',
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: 'ok', internalNote: null, commentaryLog: null,
    teamLogin: 'IPNXRODRIGOS', teamTechnicianName: 'Rodrigo', teamPhone: null, teamEmail: null,
    iclassCreatedAt: '2026-05-01T00:00:00.000Z', iclassUpdatedAt: '2026-05-21T17:49:12.000Z',
    rawDetail: {},
    ...overrides,
  };
}

function harness(
  taskOverrides: Partial<ScheduledTask> = {},
  seedOpts: { legacyClosure?: boolean } = {},
) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const recorder = new FakeTaskActivityRecorder();

  scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id, ...taskOverrides }, seedOpts);
  iclass.serviceOrders = [summary()];
  iclass.historyByOrder['900'] = HISTORY_CLOSED;

  const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
    now: () => new Date('2026-05-29T12:00:00Z'),
    recorder,
  });

  /** Mapea el código de resultado al stage 'hecho' — lo que habilita el cierre del ingest. */
  const mapResultCode = async () => {
    await resultCodes.upsert({ soTypeId: '1', code: RESULT_CODE, type: 'Sucesso' });
    const rc = await resultCodes.findByCode(RESULT_CODE);
    await resultCodes.assignStage(rc!.id, INSTALADO.id);
  };

  /** El staff gana la carrera con OTRO resultado: el ingest queda como perdedor. */
  const staffWinsWith = async (code: string) => {
    await applyTaskClosure(scheduling, undefined, { taskId: 't1', origin: 'staff', resultCode: code });
  };

  /** Simula el siguiente tick de IClass sobre la MISMA OS (bump de iclassUpdatedAt). */
  const bumpUpdatedAt = (iso: string) => {
    iclass.serviceOrders = [summary({ iclassUpdatedAt: iso })];
  };

  const conflicts = () => recorder.calls.filter(c => c.type === 'closure_conflict');

  return { scheduling, iclass, resultCodes, closed, state, recorder, useCase, mapResultCode, staffWinsWith, bumpUpdatedAt, conflicts };
}

let logSpy: jest.SpyInstance;
beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());
const loggedConflict = () => logSpy.mock.calls.some(c => typeof c[0] === 'string' && c[0].includes('[task-closure-conflict]'));

describe('FIX-B (1) — la ingesta que BAILÓ sin intentar cerrar no consume el derecho a reportar', () => {
  it('primera corrida con el código SIN MAPEAR (espejo escrito, cero cierre) → la segunda SÍ reporta', async () => {
    const h = harness();
    await h.staffWinsWith('REAGENDADO'); // el staff cierra primero, con otro resultado

    // Corrida 1: el resultCode no está mapeado → no hay move → NO se intenta cerrar.
    await h.useCase.execute();
    expect(await h.closed.findSyncStateByIclassId('900')).not.toBeNull(); // el ESPEJO sí quedó escrito
    expect(h.conflicts()).toHaveLength(0); // y no hubo conflicto: nunca se intentó cerrar

    // El operador mapea el código y llega el siguiente tick (mismo iclassUpdatedAt daría
    // el atajo de idempotencia, así que IClass bumpea como hace en la vida real).
    await h.mapResultCode();
    h.bumpUpdatedAt('2026-05-22T10:00:00.000Z');

    await h.useCase.execute();

    // ESTE es el primer y único intento de cierre: la discrepancia tiene que salir.
    expect(h.conflicts()).toHaveLength(1);
    expect(h.conflicts()[0]!.payload.metadata).toMatchObject({
      winnerOrigin: 'staff',
      winnerResultCode: 'REAGENDADO',
      loserOrigin: 'iclass',
      loserResultCode: RESULT_CODE,
    });
    expect(loggedConflict()).toBe(true);
  });
});

describe('FIX-B (2) — FIX-4(d) sigue vivo: una re-ingesta tras el conflicto ya reportado NO re-reporta', () => {
  it('tres bumps de iclassUpdatedAt después del primer cierre → exactamente UN closure_conflict', async () => {
    const h = harness();
    await h.mapResultCode();
    await h.staffWinsWith('REAGENDADO');

    await h.useCase.execute();
    expect(h.conflicts()).toHaveLength(1); // presencia antes que ausencia

    for (const iso of ['2026-05-22T10:00:00.000Z', '2026-05-23T10:00:00.000Z', '2026-05-24T10:00:00.000Z']) {
      h.bumpUpdatedAt(iso);
      await h.useCase.execute();
    }

    expect(h.conflicts()).toHaveLength(1); // ni uno más
  });
});

describe('FIX-B (3) — el flujo normal de primera vez sigue reportando', () => {
  it('código mapeado desde el arranque + staff ganador con otro resultado → reporta en la primera corrida', async () => {
    const h = harness();
    await h.mapResultCode();
    await h.staffWinsWith('REAGENDADO');

    await h.useCase.execute();

    expect(h.conflicts()).toHaveLength(1);
    expect(loggedConflict()).toBe(true);
  });

  it('sin discrepancia real (mismo código) no se reporta aunque sea el primer intento', async () => {
    const h = harness();
    await h.mapResultCode();
    await h.staffWinsWith(RESULT_CODE); // MISMO código → idempotencia, no discrepancia

    await h.useCase.execute();

    expect(h.conflicts()).toHaveLength(0);
    expect(loggedConflict()).toBe(false);
  });
});

describe('FIX-B — el intento queda PERSISTIDO en el espejo (no es un flag en memoria del tick)', () => {
  it('closureAttemptedAt: null antes del cierre, sellado después, y estable entre corridas', async () => {
    const h = harness();
    await h.mapResultCode();

    // Antes de cualquier ingesta el espejo no existe.
    expect(await h.closed.findSyncStateByIclassId('900')).toBeNull();

    await h.useCase.execute();

    const after = await h.closed.findSyncStateByIclassId('900');
    expect(after).not.toBeNull();
    expect(typeof after!.closureAttemptedAt).toBe('string');
    expect(Number.isNaN(Date.parse(after!.closureAttemptedAt!))).toBe(false);

    // Un segundo tick no re-sella (el intento es el PRIMERO, no el último).
    const sealed = after!.closureAttemptedAt;
    h.bumpUpdatedAt('2026-05-22T10:00:00.000Z');
    await h.useCase.execute();
    expect((await h.closed.findSyncStateByIclassId('900'))!.closureAttemptedAt).toBe(sealed);
  });

  it('una ingesta que BAILA por código sin mapear NO sella el intento', async () => {
    const h = harness();

    await h.useCase.execute();

    const state = await h.closed.findSyncStateByIclassId('900');
    expect(state).not.toBeNull(); // el espejo está…
    expect(state!.closureAttemptedAt).toBeNull(); // …pero el intento no ocurrió
  });

  // ── FIX-δ(d) (fix wave 3) — el bail #41 G2 estaba SÓLO en el docstring ────────────
  // El otro bail que se saltea el cierre (la tarea `dismissed`: espejo sí, side-effects
  // no) motivó FIX-B en prosa pero nunca tuvo test. Sin él, mover el `markClosureAttempted`
  // arriba de ese `return` — el bug exacto que FIX-B arregló — pasaba en verde.
  it('una ingesta que BAILA por tarea DISMISSED tampoco sella el intento', async () => {
    const h = harness({ generalStatus: 'dismissed' });
    await h.mapResultCode();

    await h.useCase.execute();

    const state = await h.closed.findSyncStateByIclassId('900');
    expect(state).not.toBeNull(); // el espejo SÍ se escribe (#41 G2: mirror-only)
    expect(state!.closureAttemptedAt).toBeNull(); // …y el cierre nunca se intentó
    expect(h.conflicts()).toHaveLength(0);

    // Y el derecho a reportar SIGUE INTACTO: el operador reabre, el staff cierra con
    // otro resultado y el siguiente tick por fin intenta cerrar → la discrepancia sale.
    await h.scheduling.updateTask('t1', { generalStatus: 'open' });
    await h.staffWinsWith('REAGENDADO');
    h.bumpUpdatedAt('2026-05-22T10:00:00.000Z');
    await h.useCase.execute();

    expect(h.conflicts()).toHaveLength(1);
  });
});

/**
 * ── LOW-1 (fix wave 3 W1a) — la supresión LEGACY no consume el derecho a reportar ───
 *
 * FIX-A hizo bien en CALLAR contra una fila legacy (cuatro columnas en null = "no hay
 * dato", no "un ganador que cerró sin resultado"). Pero el sello del gate se estampaba
 * IGUAL, aunque no se hubiera juzgado nada: el único disparo del gate se gastaba en un
 * no-evento. El conflicto REAL posterior — el operador reabre, alguien cierra POST
 * migración con otro resultado, IClass bumpea — quedaba suprimido para siempre.
 *
 * Regla: el sello se consume sólo cuando el intento fue EVALUABLE-REPORTABLE (cierre
 * ganado, o derrota contra un ganador post-migración, se haya reportado o no).
 */
describe('LOW-1 — la derrota contra una fila LEGACY no gasta el gate', () => {
  it('backfill legacy (silencio, sin sello) → el conflicto real POSTERIOR sí se reporta, una vez', async () => {
    const h = harness({ generalStatus: 'closed', isClosed: true }, { legacyClosure: true });
    await h.mapResultCode();

    // Corrida 1 — el backfill sobre la tarea cerrada hace meses.
    await h.useCase.execute();
    const afterBackfill = await h.closed.findSyncStateByIclassId('900');
    expect(afterBackfill).not.toBeNull(); // presencia: el flujo corrió de verdad (espejo escrito)
    expect(h.conflicts()).toHaveLength(0); // FIX-A: silencio contra la fila legacy
    expect(afterBackfill!.closureAttemptedAt).toBeNull(); // …y NO consumió el derecho a reportar

    // Post-migración: el operador reabre y el staff cierra con OTRO resultado.
    await h.scheduling.updateTask('t1', { generalStatus: 'open' });
    await h.staffWinsWith('REAGENDADO');
    h.bumpUpdatedAt('2026-05-22T10:00:00.000Z');

    await h.useCase.execute();

    expect(h.conflicts()).toHaveLength(1);
    expect(h.conflicts()[0]!.payload.metadata).toMatchObject({
      winnerOrigin: 'staff',
      winnerResultCode: 'REAGENDADO',
      loserOrigin: 'iclass',
      loserResultCode: RESULT_CODE,
    });
    expect(loggedConflict()).toBe(true);
    // AHORA sí se selló: el intento fue evaluable.
    expect(typeof (await h.closed.findSyncStateByIclassId('900'))!.closureAttemptedAt).toBe('string');

    // Y una vez consumido, FIX-4(d) sigue vivo: ni un reporte más.
    h.bumpUpdatedAt('2026-05-23T10:00:00.000Z');
    await h.useCase.execute();
    expect(h.conflicts()).toHaveLength(1);
  });

  it('re-ingesta repetida de la MISMA fila legacy: silencio siempre, y ni un sello fantasma', async () => {
    const h = harness({ generalStatus: 'closed', isClosed: true }, { legacyClosure: true });
    await h.mapResultCode();

    for (const iso of ['2026-05-22T10:00:00.000Z', '2026-05-23T10:00:00.000Z', '2026-05-24T10:00:00.000Z']) {
      h.bumpUpdatedAt(iso);
      await h.useCase.execute();
    }

    expect(h.conflicts()).toHaveLength(0);
    expect(loggedConflict()).toBe(false);
    expect((await h.closed.findSyncStateByIclassId('900'))!.closureAttemptedAt).toBeNull();
  });

  it('CONTRASTE: la derrota SILENCIADA por código IGUAL (ganador post-migración) SÍ gasta el gate', async () => {
    // No hubo reporte, pero SÍ hubo juicio: el ganador tiene sello post-migración y su
    // código coincide. Ese intento es evaluable-reportable y consume el disparo.
    const h = harness();
    await h.mapResultCode();
    await h.staffWinsWith(RESULT_CODE);

    await h.useCase.execute();

    expect(h.conflicts()).toHaveLength(0);
    expect(typeof (await h.closed.findSyncStateByIclassId('900'))!.closureAttemptedAt).toBe('string');
  });
});
