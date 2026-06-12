/**
 * TDD — #55 (iclass-contract-code).
 * When a CUSTOMER task carries a contract code, the IClass OS `customerCode`
 * must identify the CONTRACT (Contract.grContratoId), NOT the client.
 * When the task has no contract, it falls back to the client customerCode.
 * The NETWORK path is unaffected (covered by existing network tests).
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { Stage } from '../../domain/entities/workflow';

const FLAG_KEY = 'iclass-integration';
const WF = 'wf-1';

const ENVIAR_STAGE: Stage = {
  id: 'stage-enviar', workflowId: WF, name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5, color: null,
};
const REGISTRADO_STAGE: Stage = {
  id: 'stage-registrado', workflowId: WF, name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null,
};

const DEFAULT_SO_TYPE = { id: 'so-type-1', code: 'INSTALL', active: true };
const DEFAULT_PROJECT_ID = 'proj-1';

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);
  tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'Instalaciones FTTH', iclassSoType: DEFAULT_SO_TYPE });

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, true);

  const iclass = new InMemoryIClassClient();
  iclass.nodes = [{ nodeId: 1000, code: 'Rosario', description: 'Rosario' }];

  const useCase = new SendTaskToIClass(tasks, flags, iclass);
  return { tasks, stages, flags, iclass, useCase };
}

function fullTask(tasks: InMemorySchedulingRepository, overrides: Partial<Parameters<typeof tasks.seedTask>[0]> = {}) {
  return tasks.seedTask({
    id: 't1',
    stageId: ENVIAR_STAGE.id,
    customerId: 'c1',
    customerCode: 'CLI-99',
    customerName: 'Juan Pérez',
    customerPhone: '341555000',
    customerCity: 'Rosario',
    address: 'Calle Falsa 123',
    description: 'Instalar fibra',
    projectId: DEFAULT_PROJECT_ID,
    ...overrides,
  });
}

describe('SendTaskToIClass — #55 contract-code precedence', () => {
  it('sends the CONTRACT code as customerCode when the task has a contractCode', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { contractCode: 'CTR-204382', customerCode: 'CLI-99' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input.customerCode).toBe('CTR-204382');
  });

  it('falls back to the CLIENT customerCode when the task has no contractCode', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { contractCode: null, customerCode: 'CLI-99' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input.customerCode).toBe('CLI-99');
  });
});
