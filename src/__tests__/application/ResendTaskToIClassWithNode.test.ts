/**
 * TDD — ResendTaskToIClassWithNode use case (T-14)
 * Traza: REQ-RESEND-1..8, REQ-AUDIT-5.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassDispatchAttemptRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository';
import { ResendTaskToIClassWithNode } from '../../application/use-cases/ResendTaskToIClassWithNode';
import { TaskNotFoundError } from '../../domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  IClassRejectedError,
  IClassUnavailableError,
} from '../../domain/errors/iclass';
import { Stage } from '../../domain/entities/workflow';

const FLAG_KEY = 'iclass-integration';
const WF = 'wf-1';

const ENVIAR_STAGE: Stage = {
  id: 'stage-enviar',
  workflowId: WF,
  name: 'Enviar a IClass',
  code: 'send_to_iclass',
  category: 'enProgreso',
  order: 5,
  color: null,
};
const REGISTRADO_STAGE: Stage = {
  id: 'stage-registrado',
  workflowId: WF,
  name: 'Registrado en IClass',
  code: 'registered_in_iclass',
  category: 'enProgreso',
  order: 6,
  color: null,
};

const DEFAULT_SO_TYPE = { id: 'so-type-1', code: 'INSTALL', active: true };
const DEFAULT_PROJECT_ID = 'proj-1';

function setup(opts?: { nodes?: string[]; failureMode?: 'rejected' | 'unavailable' }) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);
  tasks.seedProject({
    id: DEFAULT_PROJECT_ID,
    title: 'Instalaciones FTTH',
    iclassSoType: DEFAULT_SO_TYPE,
  });

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, true);

  const iclass = new InMemoryIClassClient();
  iclass.nodes = (opts?.nodes ?? ['Rosario', 'Lujan', 'Mercedes']).map((c, i) => ({ nodeId: 1000 + i, code: c, description: `${c} SY` }));
  if (opts?.failureMode) iclass.failureMode = opts.failureMode;

  const attempts = new InMemoryIClassDispatchAttemptRepository();

  const useCase = new ResendTaskToIClassWithNode(tasks, flags, iclass, attempts, stages);

  return { tasks, stages, flags, iclass, attempts, useCase };
}

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

describe('ResendTaskToIClassWithNode', () => {
  it('happy path: valid nodeCode → task advances to registered_in_iclass with iclassOrderCode assigned and attempt success (REQ-RESEND-1, REQ-AUDIT-5)', async () => {
    const { tasks, iclass, attempts, useCase } = setup();
    iclass.nextOrderCode = 'OS-RESEND-1';
    fullTask(tasks);

    const result = await useCase.execute('t1', 'Lujan', 'actor-1');

    // Task advanced to registered stage
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
    // orderCode persisted
    expect(result.iclassOrderCode).toBe('OS-RESEND-1');
    // OS created with override nodeCode
    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input.nodeCode).toBe('Lujan');

    // Attempt recorded with success
    const history = await attempts.listByTask('t1');
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('success');
    expect(history[0].attemptedNodeCode).toBe('Lujan');
    expect(history[0].resolvedNodeCode).toBe('Lujan');
    expect(history[0].actorId).toBe('actor-1');
  });

  it('invalid nodeCode (not in listNodes) → IClassNodeNotFoundError, createServiceOrder NOT called, attempt node_not_found (REQ-RESEND-4)', async () => {
    const { tasks, iclass, attempts, useCase } = setup({ nodes: ['Rosario', 'Mercedes'] });
    fullTask(tasks);

    await expect(useCase.execute('t1', 'InvalidNode', 'actor-2')).rejects.toBeInstanceOf(IClassNodeNotFoundError);

    // createServiceOrder must NOT be called
    expect(iclass.createdOrders).toHaveLength(0);

    // Attempt recorded with node_not_found
    const history = await attempts.listByTask('t1');
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('node_not_found');
    expect(history[0].attemptedNodeCode).toBe('InvalidNode');
    expect(history[0].resolvedNodeCode).toBeNull();
    expect(history[0].actorId).toBe('actor-2');
  });

  it('idempotency: task already has iclassOrderCode → returns task unchanged, no createServiceOrder, no attempt (REQ-RESEND-5)', async () => {
    const { tasks, iclass, attempts, useCase } = setup();
    fullTask(tasks, { iclassOrderCode: 'OS-EXISTING', stageId: REGISTRADO_STAGE.id });

    const result = await useCase.execute('t1', 'Lujan', 'actor-1');

    expect(result.iclassOrderCode).toBe('OS-EXISTING');
    expect(iclass.createdOrders).toHaveLength(0);

    const history = await attempts.listByTask('t1');
    expect(history).toHaveLength(0);
  });

  it('taskId not found → TaskNotFoundError (REQ-RESEND-2)', async () => {
    const { useCase } = setup();
    await expect(useCase.execute('nonexistent', 'Lujan', 'actor-1')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('createServiceOrder throws IClassRejectedError → attempt rejected + rethrows (REQ-RESEND-6)', async () => {
    const { tasks, attempts, useCase } = setup({ failureMode: 'rejected' });
    fullTask(tasks);

    await expect(useCase.execute('t1', 'Lujan', 'actor-3')).rejects.toBeInstanceOf(IClassRejectedError);

    const history = await attempts.listByTask('t1');
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('rejected');
    expect(history[0].errorCode).toBe('ICLASS_REJECTED');
    expect(history[0].actorId).toBe('actor-3');
  });

  it('createServiceOrder throws IClassUnavailableError → attempt unavailable + rethrows', async () => {
    const { tasks, iclass, attempts, useCase } = setup();
    // Make listNodes work but createServiceOrder fail with unavailable
    iclass.failureMode = undefined;
    const realCreate = iclass.createServiceOrder.bind(iclass);
    void realCreate; // keep reference
    iclass.createServiceOrder = async () => { throw new IClassUnavailableError(); };
    fullTask(tasks);

    await expect(useCase.execute('t1', 'Lujan', 'actor-4')).rejects.toBeInstanceOf(IClassUnavailableError);

    const history = await attempts.listByTask('t1');
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('unavailable');
    expect(history[0].errorCode).toBe('ICLASS_UNAVAILABLE');
  });
});
