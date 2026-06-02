/**
 * TDD — SendTaskToIClass use case (task-send-to-iclass, Fase 3)
 * Covers every scenario from specs/scheduling/spec.md (REQ-MOVE-*).
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { MissingRequiredFieldsError, TaskNotFoundError } from '../../domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  IClassUnavailableError,
  MissingProjectForIClassError,
  MissingIClassMappingError,
} from '../../domain/errors/iclass';
import { Stage } from '../../domain/entities/workflow';

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

function setup(opts?: { flagEnabled?: boolean; nodes?: string[]; unavailable?: boolean }) {
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
  iclass.nodes = (opts?.nodes ?? ['Rosario']).map(c => ({ code: c, description: c }));
  if (opts?.unavailable) iclass.failureMode = 'unavailable';

  const useCase = new SendTaskToIClass(tasks, flags, iclass);
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
    iclass.nodes = [{ code: 'Rosario', description: 'Rosario' }];
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
});
