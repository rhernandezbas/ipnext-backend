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
import { IClassNodeNotFoundError, IClassUnavailableError } from '../../domain/errors/iclass';
import { Stage } from '../../domain/entities/workflow';

const FLAG_KEY = 'iclass-integration';
const WF = 'wf-1';

const ENVIAR_STAGE: Stage = {
  id: 'stage-enviar', workflowId: WF, name: 'Enviar a IClass', category: 'enProgreso', order: 5, color: null,
};
const REGISTRADO_STAGE: Stage = {
  id: 'stage-registrado', workflowId: WF, name: 'Registrado en IClass', category: 'enProgreso', order: 6, color: null,
};

function setup(opts?: { flagEnabled?: boolean; nodes?: string[]; unavailable?: boolean }) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, opts?.flagEnabled ?? true);

  const iclass = new InMemoryIClassClient();
  iclass.nodes = (opts?.nodes ?? ['Rosario']).map(c => ({ code: c, description: c }));
  if (opts?.unavailable) iclass.failureMode = 'unavailable';

  const useCase = new SendTaskToIClass(tasks, flags, iclass);
  return { tasks, stages, flags, iclass, useCase };
}

function fullTask(tasks: InMemorySchedulingRepository, overrides: Partial<Parameters<typeof tasks.seedTask>[0]> = {}) {
  return tasks.seedTask({
    id: 't1',
    stageId: ENVIAR_STAGE.id,
    customerId: 'c1',
    customerName: 'Juan Pérez',
    customerPhone: '341555000',
    customerCity: 'Rosario',
    address: 'Calle Falsa 123',
    description: 'Instalar fibra',
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

    const result = await useCase.execute('t1', ENVIAR_STAGE.id);
    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
  });

  it('happy path → creates OS without date, stores orderCode, moves to "Registrado en IClass" (REQ-MOVE-OS-1)', async () => {
    const { tasks, iclass, useCase } = setup();
    iclass.nextOrderCode = 'OS-999';
    fullTask(tasks);

    const result = await useCase.execute('t1', ENVIAR_STAGE.id);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input).toMatchObject({
      customerCode: 'c1',
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

    const result = await useCase.execute('t1', ENVIAR_STAGE.id);

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
      category: 'enProgreso', order: 6, color: null,
    });
    fullTask(tasks);

    // Pass the target stage's workflow so resolution is scoped to WF, not wf-2.
    const result = await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    // Must resolve the one in WF (target stage's workflow), not the wf-2 homonym.
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
    expect(iclass.createdOrders).toHaveLength(1);
  });
});
