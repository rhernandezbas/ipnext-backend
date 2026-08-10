/**
 * TDD — fix wave W1a / FIX-6 — los tres mutantes de la PLOMERÍA del cierre.
 *
 * `closeTaskIfOpen` escribe cuatro columnas. La suite original sólo miraba
 * `closureOrigin` (la única que viaja en el DTO), así que tres mutantes sobrevivían
 * enteros — el código podía dejar de escribir `closedAt`, dejar de pasar
 * `closedByUserId` desde CUALQUIERA de los escritores, o dejar de pasar el `resultCode`
 * en CloseIClassServiceOrder, y los 12.238 tests seguían en verde. Un campo que ningún
 * test lee es un campo que no existe.
 *
 * Acá se matan los tres, y — clave — el de `closedByUserId` se asserta POR ESCRITOR:
 * el defecto de clase es "un escritor deja de pasarlo", y un único test sobre un único
 * escritor no lo detecta en los otros tres (memoria: "fix wave: buscar el hermano").
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryClosedServiceOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { SetTaskGeneralStatus } from '@application/use-cases/SetTaskGeneralStatus';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { CloseIClassServiceOrder } from '@application/use-cases/CloseIClassServiceOrder';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { Stage } from '@domain/entities/workflow';
import { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';

const ACTOR = { actorId: 'user-77', actorName: 'Operadora' };

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

// ── FIX-6 (a) — closedAt ────────────────────────────────────────────────────────

describe('FIX-6(a) — cerrar SIEMPRE estampa closedAt', () => {
  it('closeTaskIfOpen deja un closedAt ISO parseable (in-memory)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });

    const before = Date.now();
    await repo.closeTaskIfOpen('t1', { origin: 'app', resultCode: 'OK', closedByUserId: 'u-1' });
    const after = Date.now();

    const details = repo.getClosureDetails('t1');
    expect(details).not.toBeNull();
    // No basta `expect.any(String)`: un mutante que estampe la string vacía o "null"
    // pasaría. Tiene que ser un instante REAL dentro de la ventana de la llamada.
    const ts = Date.parse(details!.closedAt);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  // FIX-G(a) (fix wave 2 W1a) — el nombre prometía LOS CUATRO y ejercitaba DOS. Un test
  // que nombra una clase entera y cubre la mitad es peor que uno honesto: el lector (y
  // el próximo review) lo da por cubierto y nadie vuelve. Se completa con los otros dos
  // escritores — los harnesses ya existían en este mismo archivo, era barato.
  it('cada uno de los 4 escritores deja closedAt (staff×2 + CloseIClassServiceOrder + el cron)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'staff-status', generalStatus: 'open', isClosed: false });
    repo.seedTask({ id: 'staff-put', generalStatus: 'open', isClosed: false });

    // 1) staff vía el endpoint dedicado de estado
    await new SetTaskGeneralStatus(repo).execute('staff-status', 'closed', ACTOR);
    // 2) staff vía el PUT genérico
    const any = new AnyLookup();
    await new UpdateTask(repo, any, any, any, any, any).execute('staff-put', { generalStatus: 'closed' }, ACTOR);

    expect(repo.getClosureDetails('staff-status')?.closedAt).toEqual(expect.any(String));
    expect(repo.getClosureDetails('staff-put')?.closedAt).toEqual(expect.any(String));

    // 3) staff-con-push: CloseIClassServiceOrder
    const { schedulingRepo, uc } = await makeCloseIClass();
    await uc.execute({ taskId: 'task-1', resultCode: 'RESOLVIDO', commentary: 'listo', actorId: 'user-77' });
    const pushDetails = schedulingRepo.getClosureDetails('task-1');
    expect(pushDetails).not.toBeNull(); // presencia antes que ausencia: cerró de verdad
    expect(pushDetails!.closedAt).toEqual(expect.any(String));

    // 4) el cron: IngestClosedServiceOrders
    const { scheduling, useCase } = ingestHarness();
    await useCase.execute();
    const cronDetails = scheduling.getClosureDetails('t1');
    expect(cronDetails).not.toBeNull();
    expect(cronDetails!.closedAt).toEqual(expect.any(String));

    // Y los cuatro closedAt tienen que ser instantes REALES, no strings cualquiera
    // (un mutante que estampe '' o 'null' pasaría el expect.any(String) de arriba).
    for (const ts of [
      repo.getClosureDetails('staff-status')!.closedAt,
      repo.getClosureDetails('staff-put')!.closedAt,
      pushDetails!.closedAt,
      cronDetails!.closedAt,
    ]) {
      expect(Number.isNaN(Date.parse(ts))).toBe(false);
    }
  });
});

// ── FIX-6 (b) — closedByUserId, POR ESCRITOR ────────────────────────────────────

describe('FIX-6(b) — cada escritor pasa su closedByUserId', () => {
  it('SetTaskGeneralStatus pasa el actorId del staff', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });

    await new SetTaskGeneralStatus(repo).execute('t1', 'closed', ACTOR);

    expect(repo.getClosureDetails('t1')?.closedByUserId).toBe('user-77');
  });

  it('SetTaskGeneralStatus sin actor → null (no inventa un usuario)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });

    await new SetTaskGeneralStatus(repo).execute('t1', 'closed');

    expect(repo.getClosureDetails('t1')?.closedByUserId).toBeNull();
  });

  it('UpdateTask (PUT genérico) pasa el actorId del staff', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    const any = new AnyLookup();

    await new UpdateTask(repo, any, any, any, any, any).execute('t1', { generalStatus: 'closed' }, ACTOR);

    expect(repo.getClosureDetails('t1')?.closedByUserId).toBe('user-77');
  });

  it('CloseIClassServiceOrder pasa el actorId del staff', async () => {
    const { schedulingRepo, uc } = await makeCloseIClass();

    await uc.execute({ taskId: 'task-1', resultCode: 'RESOLVIDO', commentary: 'listo', actorId: 'user-77' });

    expect(schedulingRepo.getClosureDetails('task-1')?.closedByUserId).toBe('user-77');
  });

  it('IngestClosedServiceOrders pasa null A PROPÓSITO (el cron no tiene usuario) — pero SÍ cierra', async () => {
    const { scheduling, useCase } = ingestHarness();

    await useCase.execute();

    const details = scheduling.getClosureDetails('t1');
    expect(details).not.toBeNull(); // presencia antes que ausencia
    expect(details!.closedByUserId).toBeNull();
  });
});

// ── FIX-6 (c) — resultCode de CloseIClassServiceOrder ───────────────────────────

describe('FIX-6(c) — CloseIClassServiceOrder propaga el resultCode al cierre', () => {
  it('como GANADOR: el resultCode queda persistido en el cierre', async () => {
    const { schedulingRepo, uc } = await makeCloseIClass();

    await uc.execute({ taskId: 'task-1', resultCode: 'RESOLVIDO', commentary: 'listo', actorId: 'u-1' });

    expect(schedulingRepo.getClosureDetails('task-1')?.resultCode).toBe('RESOLVIDO');
  });

  it('como PERDEDOR: el resultCode viaja como loserResultCode al closure_conflict', async () => {
    const { schedulingRepo, uc, recorder } = await makeCloseIClass();
    // Alguien gana la carrera con OTRO resultado justo antes de nuestro cierre local.
    let fired = false;
    schedulingRepo.setBeforeCloseWriteHook(async () => {
      if (fired) return;
      fired = true;
      schedulingRepo.setBeforeCloseWriteHook(undefined);
      await schedulingRepo.closeTaskIfOpen('task-1', { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    await uc.execute({ taskId: 'task-1', resultCode: 'RESOLVIDO', commentary: 'listo', actorId: 'u-1' });

    const conflict = recorder.calls.find(c => c.type === 'closure_conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.payload.metadata).toMatchObject({
      winnerOrigin: 'iclass',
      winnerResultCode: 'REAGENDADO',
      loserOrigin: 'staff',
      loserResultCode: 'RESOLVIDO', // ← si el use case deja de pasarlo, esto es null
    });
  });
});

// ── LOW-3 — coherencia de los helpers del repo in-memory ────────────────────────

describe('FIX-6 / LOW-3 — el repo in-memory no miente sobre el cierre', () => {
  it('seedTask({generalStatus:\'closed\'}) puebla closureDetails (si no, es una trampa para tests futuros)', () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'closed', isClosed: true, closureOrigin: 'iclass' });

    const details = repo.getClosureDetails('t1');
    expect(details).not.toBeNull();
    expect(details!.closedAt).toEqual(expect.any(String));
  });

  it('seedTask abierta NO puebla closureDetails', () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });

    expect(repo.getClosureDetails('t1')).toBeNull();
  });

  it('deleteTask limpia closureDetails (un id reciclado no hereda el cierre del anterior)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });
    await repo.closeTaskIfOpen('t1', { origin: 'app', resultCode: 'OK', closedByUserId: 'u-1' });
    expect(repo.getClosureDetails('t1')).not.toBeNull();

    expect(await repo.deleteTask('t1')).toBe(true);

    expect(repo.getClosureDetails('t1')).toBeNull();
  });
});

// ── harnesses ───────────────────────────────────────────────────────────────────

async function makeCloseIClass() {
  const stageRepo = new InMemoryStageRepository();
  const schedulingRepo = new InMemorySchedulingRepository(stageRepo);
  const iclass = new InMemoryIClassClient();
  const resultCodeRepo = new InMemoryIClassResultCodeRepository();
  const flagRepo = new InMemoryFeatureFlagRepository();
  const recorder = new (await import('../helpers/FakeTaskActivityRecorder')).FakeTaskActivityRecorder();

  await resultCodeRepo.upsert({ code: 'RESOLVIDO', type: 'Sucesso', soTypeId: null });
  flagRepo.seed('iclass-close-action', true);
  schedulingRepo.seedTask({ id: 'task-1', iclassOrderCode: 'OS-100', generalStatus: 'open', title: 'Task with OS' });
  iclass.setServiceOrderSnapshot('OS-100', { iclassId: 'iclass-id-1', iclassCodigo: 'OS-100', statusCode: '1', statusDescription: 'Aberta' });

  const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo, recorder);
  return { schedulingRepo, iclass, resultCodeRepo, flagRepo, recorder, uc };
}

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

function ingestHarness() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();

  scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
  iclass.serviceOrders = [ingestSummary()];
  iclass.historyByOrder['900'] = HISTORY_CLOSED;

  const useCase = new IngestClosedServiceOrders(iclass, closed, resultCodes, scheduling, state, {
    now: () => new Date('2026-05-29T12:00:00Z'),
  });

  // El mapeo result-code → stage 'hecho' es lo que dispara el cierre del ingest.
  const ready = (async () => {
    await resultCodes.upsert({ soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' });
    const rc = await resultCodes.findByCode('Instalacion Completa Fibra');
    await resultCodes.assignStage(rc!.id, INSTALADO.id);
  })();

  return {
    scheduling,
    useCase: { execute: async () => { await ready; return useCase.execute(); } },
  };
}
