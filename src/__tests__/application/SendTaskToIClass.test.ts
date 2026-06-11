/**
 * TDD — SendTaskToIClass use case (task-send-to-iclass, Fase 3)
 * Covers every scenario from specs/scheduling/spec.md (REQ-MOVE-*).
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassDispatchAttemptRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { MissingRequiredFieldsError, TaskNotFoundError } from '../../domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  IClassUnavailableError,
  IClassRejectedError,
  MissingProjectForIClassError,
  MissingIClassMappingError,
} from '../../domain/errors/iclass';
import { Stage } from '../../domain/entities/workflow';
import { TaskActivityRecorder } from '../../domain/ports/TaskActivityRecorder';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const FLAG_KEY = 'iclass-integration';
const WF = 'wf-1';

const ENVIAR_STAGE: Stage = {
  id: 'stage-enviar', workflowId: WF, name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5, color: null,
};
const REGISTRADO_STAGE: Stage = {
  id: 'stage-registrado', workflowId: WF, name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null,
};

/** The default mapped SO type used in happy-path fixtures. */
const DEFAULT_SO_TYPE = { id: 'so-type-1', code: 'INSTALL', active: true };
/** The default project with an active SO type. */
const DEFAULT_PROJECT_ID = 'proj-1';

function setup(opts?: { flagEnabled?: boolean; nodes?: string[]; unavailable?: boolean; recorder?: TaskActivityRecorder }) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);

  // Seed the default project so getTaskProjectMapping resolves successfully.
  tasks.seedProject({
    id: DEFAULT_PROJECT_ID,
    title: 'Instalaciones FTTH',
    iclassSoType: DEFAULT_SO_TYPE,
  });

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, opts?.flagEnabled ?? true);

  const iclass = new InMemoryIClassClient();
  iclass.nodes = (opts?.nodes ?? ['Rosario']).map((c, i) => ({ nodeId: 1000 + i, code: c, description: c }));
  if (opts?.unavailable) iclass.failureMode = 'unavailable';

  const useCase = new SendTaskToIClass(tasks, flags, iclass, undefined, opts?.recorder);
  return { tasks, stages, flags, iclass, useCase };
}

/**
 * Seeds a full task with all required fields.
 * By default includes projectId → DEFAULT_PROJECT_ID so the project-mapping guard passes.
 * Pass projectId: null to test missing-project scenarios.
 */
function fullTask(tasks: InMemorySchedulingRepository, overrides: Partial<Parameters<typeof tasks.seedTask>[0]> = {}) {
  return tasks.seedTask({
    id: 't1',
    stageId: ENVIAR_STAGE.id,
    customerId: 'c1',
    customerCode: 'GR-12345',
    customerName: 'Juan Pérez',
    customerPhone: '341555000',
    customerCity: 'Rosario',
    address: 'Calle Falsa 123',
    description: 'Instalar fibra',
    projectId: DEFAULT_PROJECT_ID,
    ...overrides,
  });
}

describe('SendTaskToIClass', () => {
  it('flag OFF → moves to target stage without touching IClass (REQ-MOVE-FLAG-OFF-1)', async () => {
    const { tasks, iclass, useCase } = setup({ flagEnabled: false });
    fullTask(tasks, { customerPhone: null, description: null }); // missing fields ignored when OFF

    const result = await useCase.execute('t1', ENVIAR_STAGE.id);

    expect(result.stageId).toBe(ENVIAR_STAGE.id);
    expect(iclass.createdOrders).toHaveLength(0);
    expect(result.iclassOrderCode).toBeNull();
  });

  it('missing required fields → MissingRequiredFieldsError with exact missingFields (REQ-MOVE-VAL-1)', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { customerPhone: null, description: null });

    await expect(useCase.execute('t1', ENVIAR_STAGE.id)).rejects.toMatchObject({
      code: 'MISSING_REQUIRED_FIELDS',
      missingFields: ['phone', 'description'],
    });
    const task = await tasks.getTask('t1');
    expect(task!.stageId).toBe(ENVIAR_STAGE.id);
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('preserves canonical order of missingFields', async () => {
    const { tasks, useCase } = setup();
    fullTask(tasks, { customerName: '', customerCity: '', address: null });

    await expect(useCase.execute('t1', ENVIAR_STAGE.id)).rejects.toMatchObject({
      missingFields: ['customerName', 'address', 'city'],
    });
  });

  it('customerId null → customerName/phone/city missing', async () => {
    const { tasks, useCase } = setup();
    tasks.seedTask({
      id: 't1', stageId: ENVIAR_STAGE.id, customerId: null,
      customerName: null, customerPhone: null, customerCity: null,
      address: 'Calle Falsa 123', description: 'Instalar fibra',
      projectId: DEFAULT_PROJECT_ID, // project guard must pass to reach field validation
    });

    const err = await useCase.execute('t1', ENVIAR_STAGE.id).catch(e => e);
    expect(err).toBeInstanceOf(MissingRequiredFieldsError);
    expect(err.missingFields).toEqual(expect.arrayContaining(['customerName', 'phone', 'city']));
  });

  it('city without matching node → IClassNodeNotFoundError, no move (REQ-OS-2)', async () => {
    const { tasks, useCase } = setup({ nodes: ['Córdoba'] });
    fullTask(tasks, { customerCity: 'Rosario' });

    await expect(useCase.execute('t1', ENVIAR_STAGE.id)).rejects.toBeInstanceOf(IClassNodeNotFoundError);
    const task = await tasks.getTask('t1');
    expect(task!.stageId).toBe(ENVIAR_STAGE.id);
  });

  it('node match is case-insensitive and trimmed', async () => {
    const { tasks, iclass, useCase } = setup({ nodes: ['  rosario '] });
    fullTask(tasks, { customerCity: 'ROSARIO' });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);
    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('node match is accent-insensitive: "Luján" matches node "Lujan"', async () => {
    const { tasks, iclass, useCase } = setup({ nodes: ['Lujan'] });
    fullTask(tasks, { customerCity: 'Luján' });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);
    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('node match handles ñ: "Cañuelas" matches node "Cañuelas"', async () => {
    const { tasks, iclass, useCase } = setup({ nodes: ['Cañuelas'] });
    fullTask(tasks, { customerCity: 'Cañuelas' });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);
    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('node match is case + accent insensitive combined: "LUJÁN" matches "Lujan"', async () => {
    const { tasks, iclass, useCase } = setup({ nodes: ['Lujan'] });
    fullTask(tasks, { customerCity: 'LUJÁN' });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);
    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('still fails when no equivalent node exists (accent normalization guard)', async () => {
    const { tasks, useCase } = setup({ nodes: ['Lujan', 'Rosario'] });
    fullTask(tasks, { customerCity: 'Pergamino' });

    await expect(useCase.execute('t1', ENVIAR_STAGE.id)).rejects.toBeInstanceOf(IClassNodeNotFoundError);
    const task = await tasks.getTask('t1');
    expect(task!.stageId).toBe(ENVIAR_STAGE.id);
  });

  it('exact match without accents still works: "Mercedes" matches "Mercedes"', async () => {
    const { tasks, iclass, useCase } = setup({ nodes: ['Mercedes'] });
    fullTask(tasks, { customerCity: 'Mercedes' });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);
    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('happy path → creates OS without date, stores orderCode, moves to "Registrado en IClass" (REQ-MOVE-OS-1)', async () => {
    const { tasks, iclass, useCase } = setup();
    iclass.nextOrderCode = 'OS-999';
    fullTask(tasks, { sequenceNumber: 4274 });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input).toMatchObject({
      soCode: '4274', // task sequenceNumber as the OS code
      customerCode: 'GR-12345', // short code (grClienteId), NOT the customerId UUID
      customerName: 'Juan Pérez',
      phone: '341555000',
      address: 'Calle Falsa 123',
      city: 'Rosario',
      description: 'Instalar fibra',
    });
    expect(result.iclassOrderCode).toBe('OS-999');
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);

    const persisted = await tasks.getTask('t1');
    expect(persisted!.iclassOrderCode).toBe('OS-999');
    expect(persisted!.stageId).toBe(REGISTRADO_STAGE.id);
  });

  // ── task-activity-log #10 / D.15 ──
  it('emits `sent_to_iclass` with the order code on a successful dispatch (D.15)', async () => {
    const recorder = new FakeTaskActivityRecorder();
    const { tasks, iclass, useCase } = setup({ recorder });
    iclass.nextOrderCode = 'OS-777';
    fullTask(tasks, { sequenceNumber: 5001 });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF, null, { actorId: 'u1', actorName: 'Alice' });

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: 't1',
        type: 'sent_to_iclass',
        payload: expect.objectContaining({
          actor: { actorId: 'u1', actorName: 'Alice' },
          toValue: { iclassOrderCode: 'OS-777' },
          metadata: { stageId: ENVIAR_STAGE.id },
        }),
      }),
    );
  });

  it('does NOT emit `sent_to_iclass` when the flag is OFF (plain move)', async () => {
    const recorder = new FakeTaskActivityRecorder();
    const { tasks, useCase } = setup({ flagEnabled: false, recorder });
    fullTask(tasks);

    await useCase.execute('t1', ENVIAR_STAGE.id, WF, null, { actorId: 'u1', actorName: 'Alice' });

    expect(recorder.calls.filter(c => c.type === 'sent_to_iclass')).toHaveLength(0);
  });

  it('sends soCode = String(task.sequenceNumber) so the OS correlates to the backend task', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { sequenceNumber: 4274 });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input.soCode).toBe('4274');
  });

  it('sends the SHORT customerCode (grClienteId) to IClass, NOT the customerId UUID', async () => {
    const { tasks, iclass, useCase } = setup();
    const UUID = '76e8b565-74e3-44c3-b57d-22f791d1d09e';
    fullTask(tasks, { customerId: UUID, customerCode: 'GR-9999' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input.customerCode).toBe('GR-9999');
    expect(iclass.createdOrders[0].input.customerCode).not.toBe(UUID);
  });

  it('falls back to login when grClienteId/splynxId are null (customerCode pre-resolved by repo)', async () => {
    const { tasks, iclass, useCase } = setup();
    // The repo resolves grClienteId ?? splynxId ?? login; here it resolved to the login.
    fullTask(tasks, { customerCode: 'juan.perez' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders[0].input.customerCode).toBe('juan.perez');
  });

  it('IClass fails → IClassUnavailableError, no move, orderCode stays null', async () => {
    const { tasks, useCase } = setup({ unavailable: true });
    fullTask(tasks);

    await expect(useCase.execute('t1', ENVIAR_STAGE.id)).rejects.toBeInstanceOf(IClassUnavailableError);
    const task = await tasks.getTask('t1');
    expect(task!.stageId).toBe(ENVIAR_STAGE.id);
    expect(task!.iclassOrderCode).toBeNull();
  });

  it('idempotency: task already has orderCode → does not recreate, moves to Registrado (AD-7)', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { iclassOrderCode: 'OS-EXISTING' });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(0);
    expect(result.iclassOrderCode).toBe('OS-EXISTING');
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    const { useCase } = setup();
    await expect(useCase.execute('nope', ENVIAR_STAGE.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('resolves "Registrado en IClass" within the SAME workflow as the target stage (homonym stages)', async () => {
    // Another workflow has a homonymous "Registrado en IClass" stage that MUST NOT be picked.
    const OTHER_WF = 'wf-2';
    const { tasks, stages, iclass, useCase } = setup();
    stages.addDirect({
      id: 'stage-registrado-other', workflowId: OTHER_WF, name: 'Registrado en IClass',
      code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null,
    });
    fullTask(tasks);

    // Pass the target stage's workflow so resolution is scoped to WF, not wf-2.
    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    // Must resolve the one in WF (target stage's workflow), not the wf-2 homonym.
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
    expect(iclass.createdOrders).toHaveLength(1);
  });

  it('resolves stage by CODE not NAME — rename-safe (REQ-MOVE-OS-1, REQ-LOGIC-1)', async () => {
    // Stage has been renamed but code is unchanged — resolution must still work.
    const stages = new InMemoryStageRepository();
    stages.addDirect({ ...ENVIAR_STAGE });
    // Stage has a different name, but same code → must still be resolved by code
    stages.addDirect({
      id: 'stage-registrado-renamed', workflowId: WF,
      name: 'En IClass (renombrado)', // name changed by operator
      code: 'registered_in_iclass',  // code is immutable
      category: 'enProgreso', order: 6, color: null,
    });
    const tasks = new InMemorySchedulingRepository(stages);
    tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'Instalaciones FTTH', iclassSoType: DEFAULT_SO_TYPE });
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    const iclass = new InMemoryIClassClient();
    iclass.nodes = [{ nodeId: 1001, code: 'Rosario', description: 'Rosario' }];
    const useCase = new SendTaskToIClass(tasks, flags, iclass);
    fullTask(tasks);

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    // Must resolve by code even though the name changed
    expect(result.stageId).toBe('stage-registrado-renamed');
    expect(iclass.createdOrders).toHaveLength(1);
  });

  // ── Project mapping guard tests (REQ-SCHED-1, REQ-SCHED-2, REQ-SCHED-3, REQ-SCHED-4) ──

  it('task with projectId=null → MissingProjectForIClassError, no IClass call (REQ-SCHED-1)', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { projectId: null });

    await expect(useCase.execute('t1', ENVIAR_STAGE.id)).rejects.toBeInstanceOf(MissingProjectForIClassError);
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('task with project but iclassSoType=null → MissingIClassMappingError with projectTitle (REQ-SCHED-2)', async () => {
    const { tasks, iclass, useCase } = setup();
    tasks.seedProject({ id: 'proj-no-type', title: 'Sin Mapeo', iclassSoType: null });
    fullTask(tasks, { projectId: 'proj-no-type' });

    const err = await useCase.execute('t1', ENVIAR_STAGE.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingIClassMappingError);
    expect((err as MissingIClassMappingError).projectTitle).toBe('Sin Mapeo');
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('task with project having inactive iclassSoType → MissingIClassMappingError (NOT IClassSoTypeInactiveError) (REQ-SCHED-3)', async () => {
    const { tasks, iclass, useCase } = setup();
    tasks.seedProject({
      id: 'proj-inactive-type',
      title: 'Proyecto Tipo Inactivo',
      iclassSoType: { id: 'so-type-old', code: 'OLD_INSTALL', active: false },
    });
    fullTask(tasks, { projectId: 'proj-inactive-type' });

    const err = await useCase.execute('t1', ENVIAR_STAGE.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingIClassMappingError);
    expect((err as MissingIClassMappingError).projectTitle).toBe('Proyecto Tipo Inactivo');
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('happy path passes the correct soType from project mapping to IClass (REQ-SCHED-4)', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { sequenceNumber: 4274 });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input.soType).toBe(DEFAULT_SO_TYPE.code);
  });

  it('idempotency: task already has orderCode + project lost mapping → still moves to Registrado without error', async () => {
    const { tasks, iclass, useCase } = setup();
    // Task already sent (has orderCode) but its project now has no soType
    tasks.seedProject({ id: 'proj-no-type-now', title: 'Sin Mapeo Ahora', iclassSoType: null });
    fullTask(tasks, {
      iclassOrderCode: 'OS-ALREADY-SENT',
      projectId: 'proj-no-type-now',
    });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    // Idempotency guard fires BEFORE project-mapping check → no error
    expect(iclass.createdOrders).toHaveLength(0);
    expect(result.iclassOrderCode).toBe('OS-ALREADY-SENT');
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('flag OFF → moves without validating project/soType (REQ-SCHED-5)', async () => {
    const { tasks, iclass, useCase } = setup({ flagEnabled: false });
    // Task with no project — would fail if flag were ON
    fullTask(tasks, { projectId: null, customerPhone: null });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id);

    expect(result.stageId).toBe(ENVIAR_STAGE.id);
    expect(iclass.createdOrders).toHaveLength(0);
  });

  // ── Audit de fallos (T-15 — REQ-AUDIT-4) ─────────────────────────────────────

  it('FALLO POR NODO: registers attempt node_not_found when city has no matching node (REQ-AUDIT-4)', async () => {
    const { tasks, flags } = setup({ nodes: ['Córdoba'] });
    const stages = new InMemoryStageRepository();
    stages.addDirect(ENVIAR_STAGE);
    stages.addDirect(REGISTRADO_STAGE);
    const taskRepo = new InMemorySchedulingRepository(stages);
    taskRepo.seedProject({ id: DEFAULT_PROJECT_ID, title: 'P', iclassSoType: { id: 'st1', code: 'INSTALL', active: true } });
    const iclass2 = new InMemoryIClassClient();
    iclass2.nodes = [{ nodeId: 1002, code: 'Córdoba', description: 'Córdoba' }];
    const attemptRepo = new InMemoryIClassDispatchAttemptRepository();
    const useCaseWithAudit = new SendTaskToIClass(taskRepo, flags, iclass2, attemptRepo);

    taskRepo.seedTask({
      id: 't-audit-1',
      stageId: ENVIAR_STAGE.id,
      customerId: 'c1',
      customerCode: 'GR-1',
      customerName: 'Juan',
      customerPhone: '123',
      customerCity: 'Rosario',
      address: 'Dir 1',
      description: 'Desc',
      projectId: DEFAULT_PROJECT_ID,
    });

    await expect(useCaseWithAudit.execute('t-audit-1', ENVIAR_STAGE.id, WF)).rejects.toBeInstanceOf(IClassNodeNotFoundError);

    const history = await attemptRepo.listByTask('t-audit-1');
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('node_not_found');
    expect(history[0].attemptedNodeCode).toBeNull();
    expect(history[0].errorCode).toBe('ICLASS_NODE_NOT_FOUND');
  });

  it('FALLO POR REJECTED: registers attempt rejected with attemptedNodeCode = resolved node (REQ-AUDIT-4)', async () => {
    const stages2 = new InMemoryStageRepository();
    stages2.addDirect(ENVIAR_STAGE);
    stages2.addDirect(REGISTRADO_STAGE);
    const taskRepo2 = new InMemorySchedulingRepository(stages2);
    taskRepo2.seedProject({ id: DEFAULT_PROJECT_ID, title: 'P', iclassSoType: { id: 'st1', code: 'INSTALL', active: true } });
    const flags2 = new InMemoryFeatureFlagRepository();
    flags2.seed(FLAG_KEY, true);
    const iclass3 = new InMemoryIClassClient();
    iclass3.nodes = [{ nodeId: 1003, code: 'Rosario', description: 'Rosario' }];
    iclass3.failureMode = 'rejected';
    const attemptRepo2 = new InMemoryIClassDispatchAttemptRepository();
    const useCaseWithAudit2 = new SendTaskToIClass(taskRepo2, flags2, iclass3, attemptRepo2);

    taskRepo2.seedTask({
      id: 't-audit-2',
      stageId: ENVIAR_STAGE.id,
      customerId: 'c1',
      customerCode: 'GR-1',
      customerName: 'Juan',
      customerPhone: '123',
      customerCity: 'Rosario',
      address: 'Dir 1',
      description: 'Desc',
      projectId: DEFAULT_PROJECT_ID,
    });

    await expect(useCaseWithAudit2.execute('t-audit-2', ENVIAR_STAGE.id, WF)).rejects.toBeInstanceOf(IClassRejectedError);

    const history2 = await attemptRepo2.listByTask('t-audit-2');
    expect(history2).toHaveLength(1);
    expect(history2[0].outcome).toBe('rejected');
    expect(history2[0].attemptedNodeCode).toBe('Rosario');
  });

  it('FALLO POR UNAVAILABLE: registers attempt unavailable (REQ-AUDIT-4)', async () => {
    const stages3 = new InMemoryStageRepository();
    stages3.addDirect(ENVIAR_STAGE);
    stages3.addDirect(REGISTRADO_STAGE);
    const taskRepo3 = new InMemorySchedulingRepository(stages3);
    taskRepo3.seedProject({ id: DEFAULT_PROJECT_ID, title: 'P', iclassSoType: { id: 'st1', code: 'INSTALL', active: true } });
    const flags3 = new InMemoryFeatureFlagRepository();
    flags3.seed(FLAG_KEY, true);
    const iclass4 = new InMemoryIClassClient();
    iclass4.nodes = [{ nodeId: 1004, code: 'Rosario', description: 'Rosario' }];
    // Only createServiceOrder fails with unavailable, listNodes works
    iclass4.createServiceOrder = async () => { throw new IClassUnavailableError(); };
    const attemptRepo3 = new InMemoryIClassDispatchAttemptRepository();
    const useCaseWithAudit3 = new SendTaskToIClass(taskRepo3, flags3, iclass4, attemptRepo3);

    taskRepo3.seedTask({
      id: 't-audit-3',
      stageId: ENVIAR_STAGE.id,
      customerId: 'c1',
      customerCode: 'GR-1',
      customerName: 'Juan',
      customerPhone: '123',
      customerCity: 'Rosario',
      address: 'Dir 1',
      description: 'Desc',
      projectId: DEFAULT_PROJECT_ID,
    });

    await expect(useCaseWithAudit3.execute('t-audit-3', ENVIAR_STAGE.id, WF)).rejects.toBeInstanceOf(IClassUnavailableError);

    const history3 = await attemptRepo3.listByTask('t-audit-3');
    expect(history3).toHaveLength(1);
    expect(history3[0].outcome).toBe('unavailable');
  });

  it('EXITO SIN ATTEMPT: successful send does NOT record any attempt (REQ-AUDIT-4, AD-7)', async () => {
    const stages4 = new InMemoryStageRepository();
    stages4.addDirect(ENVIAR_STAGE);
    stages4.addDirect(REGISTRADO_STAGE);
    const taskRepo4 = new InMemorySchedulingRepository(stages4);
    taskRepo4.seedProject({ id: DEFAULT_PROJECT_ID, title: 'P', iclassSoType: { id: 'st1', code: 'INSTALL', active: true } });
    const flags4 = new InMemoryFeatureFlagRepository();
    flags4.seed(FLAG_KEY, true);
    const iclass5 = new InMemoryIClassClient();
    iclass5.nodes = [{ nodeId: 1005, code: 'Rosario', description: 'Rosario' }];
    const attemptRepo4 = new InMemoryIClassDispatchAttemptRepository();
    const useCaseSuccess = new SendTaskToIClass(taskRepo4, flags4, iclass5, attemptRepo4);

    taskRepo4.seedTask({
      id: 't-audit-4',
      stageId: ENVIAR_STAGE.id,
      customerId: 'c1',
      customerCode: 'GR-1',
      customerName: 'Juan',
      customerPhone: '123',
      customerCity: 'Rosario',
      address: 'Dir 1',
      description: 'Desc',
      projectId: DEFAULT_PROJECT_ID,
    });

    await useCaseSuccess.execute('t-audit-4', ENVIAR_STAGE.id, WF);

    // No attempt should be recorded on success
    const history4 = await attemptRepo4.listByTask('t-audit-4');
    expect(history4).toHaveLength(0);
  });

  it('AUDIT NO FATAL: audit repo that throws does NOT suppress the domain error (AD-6)', async () => {
    const stages5 = new InMemoryStageRepository();
    stages5.addDirect(ENVIAR_STAGE);
    stages5.addDirect(REGISTRADO_STAGE);
    const taskRepo5 = new InMemorySchedulingRepository(stages5);
    taskRepo5.seedProject({ id: DEFAULT_PROJECT_ID, title: 'P', iclassSoType: { id: 'st1', code: 'INSTALL', active: true } });
    const flags5 = new InMemoryFeatureFlagRepository();
    flags5.seed(FLAG_KEY, true);
    const iclass6 = new InMemoryIClassClient();
    iclass6.nodes = [{ nodeId: 1006, code: 'Córdoba', description: 'Córdoba' }]; // Rosario won't match

    // Audit repo that always throws
    const faultyAttemptRepo = new InMemoryIClassDispatchAttemptRepository();
    faultyAttemptRepo.record = async () => { throw new Error('db down'); };

    const useCaseWithFaultyAudit = new SendTaskToIClass(taskRepo5, flags5, iclass6, faultyAttemptRepo);

    taskRepo5.seedTask({
      id: 't-audit-5',
      stageId: ENVIAR_STAGE.id,
      customerId: 'c1',
      customerCode: 'GR-1',
      customerName: 'Juan',
      customerPhone: '123',
      customerCity: 'Rosario', // will fail node match → IClassNodeNotFoundError
      address: 'Dir 1',
      description: 'Desc',
      projectId: DEFAULT_PROJECT_ID,
    });

    // The IClassNodeNotFoundError (domain error) must propagate, NOT the audit 'db down' error
    await expect(useCaseWithFaultyAudit.execute('t-audit-5', ENVIAR_STAGE.id, WF)).rejects.toBeInstanceOf(IClassNodeNotFoundError);
  });
});
