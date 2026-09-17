/**
 * STRICT TDD — scenarios B1-B10 from the design matrix.
 * Tests written BEFORE the implementation.
 */
import { AutoAssignIClassTeamOnTaskUpdate } from '@application/use-cases/AutoAssignIClassTeamOnTaskUpdate';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { IClassRejectedError } from '@domain/errors/iclass';

const TASK_ID = 'task-autoassign';
const ORDER_CODE = 'OS-AUTO-1';
const TEAM_LOGIN = 'equipe-auto';
const ACTOR = { actorId: 'op-1', actorName: 'Operator' };

async function makeRepos() {
  const stageRepo = new InMemoryStageRepository();
  const schedulingRepo = new InMemorySchedulingRepository(stageRepo);
  const iclass = new InMemoryIClassClient();
  const teamRepo = new InMemoryIClassTeamRepository();
  const flagRepo = new InMemoryFeatureFlagRepository();
  const userRepo = new InMemoryRbacUserRepository(undefined, undefined, teamRepo);

  // Seed flag ON
  flagRepo.seed('iclass-assign-action', true);

  // Seed active+selectable team
  await teamRepo.upsertByLogin({ login: TEAM_LOGIN, name: 'Equipe Auto', thirdPartyCode: null, active: true, selectable: true });

  // Seed technician with team mapped
  const tech = await userRepo.create({ name: 'Tech One', email: 'tech1@test.com', login: 'tech1', passwordHash: 'h' });
  await userRepo.update(tech.id, { iclassTeamLogin: TEAM_LOGIN });

  // Seed task with iclassOrderCode, open, and schedule window
  schedulingRepo.seedTask({
    id: TASK_ID,
    iclassOrderCode: ORDER_CODE,
    generalStatus: 'open',
    title: 'Task Auto',
    startDate: '2026-06-18T11:00:00.000Z',
    endDate: '2026-06-18T15:00:00.000Z',
  });

  // Seed OS snapshot (non-terminal)
  iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-auto-1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

  return { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId: tech.id };
}

describe('AutoAssignIClassTeamOnTaskUpdate', () => {
  // B1: happy path → updateServiceOrder called + activity recorded + outcome assigned
  it('B1: happy path → outcome assigned + updateServiceOrder called + activity recorded', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();

    const activityLog: { type: string }[] = [];
    const recorder = {
      record: async (_id: string, type: string) => { activityLog.push({ type }); },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('assigned');
    expect(result.teamLogin).toBe(TEAM_LOGIN);
    const updateCalls = iclass.getUpdateServiceOrderCalls();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.requiredTeam).toBe(TEAM_LOGIN);
    expect(updateCalls[0]!.serviceOrderCode).toBe(ORDER_CODE);
    // Schedule window must be passed to updateServiceOrder
    expect(updateCalls[0]!.scheduleStart).toBeInstanceOf(Date);
    expect(updateCalls[0]!.scheduleEnd).toBeInstanceOf(Date);
    expect(updateCalls[0]!.scheduleStart.toISOString()).toBe('2026-06-18T11:00:00.000Z');
    expect(updateCalls[0]!.scheduleEnd.toISOString()).toBe('2026-06-18T15:00:00.000Z');
    expect(activityLog).toHaveLength(1);
    expect(activityLog[0]!.type).toBe('iclass_team_auto_assigned');
  });

  // B2: flag OFF → skipped: flag-off, IClass NOT called
  it('B2: flag OFF → skipped: flag-off, IClass NOT called', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    flagRepo.seed('iclass-assign-action', false);

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('flag-off');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // B3: task has no iclassOrderCode → skipped: no-order-code
  it('B3: task without iclassOrderCode → skipped: no-order-code', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    schedulingRepo.seedTask({ id: 'task-no-os', iclassOrderCode: null, generalStatus: 'open', title: 'No OS' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign('task-no-os', techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no-order-code');
  });

  // B4: technician has no iclassTeamLogin → skipped: no-mapping
  it('B4: technician without iclassTeamLogin → skipped: no-mapping', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo } = await makeRepos();
    const unmapped = await userRepo.create({ name: 'No team', email: 'nomapping@test.com', login: 'nomapping', passwordHash: 'h' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, unmapped.id, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no-mapping');
  });

  // B5: assigneeId null → skipped: unassigned (desasignar).
  // "Nadie asignado" y "el técnico no tiene cuadrilla" se arreglan distinto: no se mezclan.
  it('B5: assigneeId null → skipped: unassigned', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo } = await makeRepos();

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, null, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('unassigned');
  });

  // B6: cuadrilla mapeada quedó inactiva → skipped: team-inactive
  it('B6: mapped team became inactive → skipped: team-inactive, IClass NOT called', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    // Deactivate the team (simulate sync making it inactive)
    await teamRepo.upsertByLogin({ login: TEAM_LOGIN, name: 'Equipe Auto', thirdPartyCode: null, active: false, selectable: true });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('team-inactive');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // B7: task not open → skipped: not-open
  it('B7: task generalStatus !== open → skipped: not-open', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    schedulingRepo.seedTask({ id: 'task-closed', iclassOrderCode: ORDER_CODE, generalStatus: 'closed', title: 'Closed' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign('task-closed', techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('not-open');
  });

  // B8: OS terminal in IClass (statusCode '7') → skipped: order-closed
  it('B8: OS terminal in IClass → skipped: order-closed, updateServiceOrder NOT called', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-auto-1', iclassCodigo: ORDER_CODE, statusCode: '7', statusDescription: 'Fechada' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('order-closed');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // B8b: task has no startDate/endDate → skipped: no-schedule. Chequeo LOCAL, así que
  // no necesita (ni consulta) el snapshot de IClass: una tarea sin ventana nunca se
  // puede empujar, no tiene sentido gastar un round-trip que puede rate-limitar.
  it('B8b: task has no schedule window (startDate/endDate null) → skipped: no-schedule, WITHOUT calling getServiceOrder', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    // Seed a task without dates
    schedulingRepo.seedTask({
      id: 'task-no-sched',
      iclassOrderCode: ORDER_CODE,
      generalStatus: 'open',
      title: 'No Schedule',
      startDate: null,
      endDate: null,
    });
    // A propósito SIN snapshot seedeado: si el código llamara a getServiceOrder acá,
    // InMemoryIClassClient devolvería null y el motivo sería 'order-not-found', no
    // 'no-schedule' — la aserción de abajo lo cazaría.

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign('task-no-sched', techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no-schedule');
    expect(iclass.getGetServiceOrderCalls()).toHaveLength(0);
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // B9: IClass rejects → failed: rejected + activity recorded + NEVER propagates
  it('B9: IClass rejects → failed: rejected, activity recorded, no throw', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setUpdateMode('rejected');

    const activityLog: { type: string }[] = [];
    const recorder = {
      record: async (_id: string, type: string) => { activityLog.push({ type }); },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('rejected');
    expect(activityLog.some(a => a.type === 'iclass_team_auto_assign_failed')).toBe(true);
    // No throw
  });

  // Sin el mensaje, 697 fallos en producción quedaron indistinguibles entre sí.
  it('B9b: the recorded failure carries the message IClass gave', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setUpdateMode('rejected');

    const activityLog: { type: string; metadata: Record<string, unknown> | null | undefined }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { metadata?: Record<string, unknown> | null }) => {
        activityLog.push({ type, metadata: payload.metadata });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    await uc.maybeAssign(TASK_ID, techId, ACTOR);

    const failure = activityLog.find(a => a.type === 'iclass_team_auto_assign_failed');
    expect(String(failure!.metadata?.message ?? '')).not.toBe('');
  });

  // Un skip silencioso deja la tarea reprogramada en Prominense y la ventana vieja en
  // IClass: el técnico va el día equivocado y nadie se entera. El skip tiene que verse.
  it('B11: flag OFF on an IClass-linked task → records a skip activity with the reason', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    flagRepo.seed('iclass-assign-action', false);

    const activityLog: { type: string; toValue: unknown }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { toValue?: unknown }) => {
        activityLog.push({ type, toValue: payload.toValue });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.reason).toBe('flag-off');
    expect(activityLog).toEqual([{ type: 'iclass_team_auto_assign_skipped', toValue: 'flag-off' }]);
  });

  // Una tarea que nunca fue a IClass no tiene nada que reportar: sin ruido en la timeline.
  it('B12: a task with no iclassOrderCode records NO skip activity', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    schedulingRepo.seedTask({ id: 'task-no-os', iclassOrderCode: null, generalStatus: 'open', title: 'No OS' });

    const activityLog: string[] = [];
    const recorder = {
      record: async (_id: string, type: string) => { activityLog.push(type); },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    await uc.maybeAssign('task-no-os', techId, ACTOR);

    expect(activityLog).toEqual([]);
  });

  // "No la encontré" y "está cerrada" son diagnósticos distintos y se arreglan distinto.
  it('B13: OS not found in IClass → skipped: order-not-found + skip activity', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setServiceOrderSnapshot(ORDER_CODE, null);

    const activityLog: { type: string; toValue: unknown }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { toValue?: unknown }) => {
        activityLog.push({ type, toValue: payload.toValue });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('order-not-found');
    expect(activityLog).toEqual([{ type: 'iclass_team_auto_assign_skipped', toValue: 'order-not-found' }]);
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // Reprogramar sin ventana es exactamente el caso que se pierde en silencio.
  it('B14: no schedule window → skip activity recorded', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    schedulingRepo.seedTask({
      id: 'task-no-sched',
      iclassOrderCode: ORDER_CODE,
      generalStatus: 'open',
      title: 'No Schedule',
      startDate: null,
      endDate: null,
    });

    const activityLog: { type: string; toValue: unknown }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { toValue?: unknown }) => {
        activityLog.push({ type, toValue: payload.toValue });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    await uc.maybeAssign('task-no-sched', techId, ACTOR);

    expect(activityLog).toEqual([{ type: 'iclass_team_auto_assign_skipped', toValue: 'no-schedule' }]);
  });

  // Reprogramar con el mismo técnico también empuja la ventana: la timeline tiene que
  // mostrar QUÉ ventana se mandó, o "auto asignado" parece un cambio de cuadrilla.
  it('B15: the success activity carries the schedule window pushed to IClass', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();

    const activityLog: { type: string; metadata: Record<string, unknown> | null | undefined }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { metadata?: Record<string, unknown> | null }) => {
        activityLog.push({ type, metadata: payload.metadata });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    await uc.maybeAssign(TASK_ID, techId, ACTOR);

    const assigned = activityLog.find(a => a.type === 'iclass_team_auto_assigned');
    expect(assigned!.metadata).toMatchObject({
      scheduleStart: '2026-06-18T11:00:00.000Z',
      scheduleEnd: '2026-06-18T15:00:00.000Z',
    });
  });

  // B10: IClass unavailable → failed: unavailable + NEVER propagates
  it('B10: IClass unavailable → failed: unavailable, no throw', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setUpdateMode('unavailable');

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('unavailable');
    // No throw
  });

  // Extra: maybeAssign NEVER throws even on unexpected errors
  it('NEVER throws: internal crash → returns failed outcome', async () => {
    const { schedulingRepo, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    // Inject a broken IClass that throws unexpectedly
    const brokenIClass = {
      getServiceOrder: async () => { throw new Error('Unexpected crash'); },
      updateServiceOrder: async () => { throw new Error('Should not reach'); },
    } as any;

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, brokenIClass, teamRepo, flagRepo, userRepo);

    // This MUST NOT throw — it's best-effort
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);
    expect(result.outcome).toBe('failed');
  });

  // El rate-limit de IClass ("Espere um pouco") revienta el pre-check ANTES del push.
  // Sin actividad, la reprogramación se pierde exactamente igual que antes del fix:
  // Prominense muestra el día nuevo, IClass conserva la ventana vieja, timeline en blanco.
  it('B16: the pre-check throwing records a failure activity with the message', async () => {
    const { schedulingRepo, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    const brokenIClass = {
      getServiceOrder: async () => { throw new Error('IClass responded with HTTP 503'); },
      updateServiceOrder: async () => { throw new Error('Should not reach'); },
    } as any;

    const activityLog: { type: string; metadata: Record<string, unknown> | null | undefined }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { metadata?: Record<string, unknown> | null }) => {
        activityLog.push({ type, metadata: payload.metadata });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, brokenIClass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('failed');
    const failure = activityLog.find(a => a.type === 'iclass_team_auto_assign_failed');
    expect(failure).toBeDefined();
    expect(String(failure!.metadata?.message ?? '')).toContain('503');
  });

  // El read que decide si la tarea tiene OS también puede caerse (DB caída, timeout).
  // Callarlo sería el MISMO agujero: la fecha ya está guardada localmente y no hay
  // forma de saber, sin este registro, que la reprogramación nunca llegó a evaluarse.
  it('B19: schedulingRepo.getTask throwing records a failure activity too', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    const brokenSchedulingRepo = new Proxy(schedulingRepo, {
      get(target, prop, receiver) {
        if (prop === 'getTask') return async () => { throw new Error('DB timeout'); };
        return Reflect.get(target, prop, receiver);
      },
    });

    const activityLog: { type: string; metadata: Record<string, unknown> | null | undefined }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { metadata?: Record<string, unknown> | null }) => {
        activityLog.push({ type, metadata: payload.metadata });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(brokenSchedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('failed');
    const failure = activityLog.find(a => a.type === 'iclass_team_auto_assign_failed');
    expect(failure).toBeDefined();
    expect(String(failure!.metadata?.message ?? '')).toContain('DB timeout');
  });

  // El motivo devuelto por maybeAssign tiene que coincidir con el que quedó escrito en
  // la timeline — si no, quien lea el resultado y quien lea el historial ven cosas
  // distintas para el MISMO fallo.
  it('B20: the pre-check throwing IClassRejectedError reports "rejected" in BOTH the outcome and the activity', async () => {
    const { schedulingRepo, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    const brokenIClass = {
      getServiceOrder: async () => { throw new IClassRejectedError('IClass rechazó la consulta'); },
      updateServiceOrder: async () => { throw new Error('Should not reach'); },
    } as any;

    const activityLog: { type: string; toValue: unknown }[] = [];
    const recorder = {
      record: async (_id: string, type: string, payload: { toValue?: unknown }) => {
        activityLog.push({ type, toValue: payload.toValue });
      },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, brokenIClass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('rejected');
    const failure = activityLog.find(a => a.type === 'iclass_team_auto_assign_failed');
    expect(failure!.toValue).toBe('rejected');
  });

  // Una OS en APROVAÇÃO (50) tampoco acepta escrituras: IClass la rechaza con ICLERR_0212.
  // Empujarla igual gasta un round-trip y reporta "rechazado" en vez del motivo real.
  it('B17: OS awaiting approval (statusCode 50) → skipped: order-closed, IClass NOT called', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-auto-1', iclassCodigo: ORDER_CODE, statusCode: '50', statusDescription: 'Aprovação' });

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('order-closed');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(0);
  });

  // Un recorder roto DESPUÉS de que IClass ya aceptó el push no puede reportar "falló":
  // sería la divergencia inversa — el operador reprograma de nuevo sobre algo que ya viajó.
  it('B18: the recorder failing after a successful push still reports assigned', async () => {
    const { schedulingRepo, iclass, teamRepo, flagRepo, userRepo, techId } = await makeRepos();
    const recorder = {
      record: async () => { throw new Error('recorder down'); },
      recordMany: async () => {},
    };

    const uc = new AutoAssignIClassTeamOnTaskUpdate(schedulingRepo, iclass, teamRepo, flagRepo, userRepo, recorder);
    const result = await uc.maybeAssign(TASK_ID, techId, ACTOR);

    expect(result.outcome).toBe('assigned');
    expect(iclass.getUpdateServiceOrderCalls()).toHaveLength(1);
  });
});
