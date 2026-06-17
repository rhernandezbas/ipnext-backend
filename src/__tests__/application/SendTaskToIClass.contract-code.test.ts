/**
 * TDD — #55 revisado por #121 (iclass-os-address-by-contract).
 *
 * MODELO (decisión del usuario): cliente = customer, contrato = dirección.
 *   - customerCode (IClass) = el CLIENTE  = task.customerCode
 *   - addressCode  (IClass) = el CONTRATO = task.contractCode (fallback task.customerCode, NUNCA el soCode)
 *   - soCode       (IClass) = sequenceNumber → SIN CAMBIO (clave de matching del cierre)
 *
 * Resultado: un cliente con N contratos → 1 customer + N direcciones (una por contrato,
 * estable) + N OS por contrato (cada una con soCode único).
 *
 * Esto REVISA el #55: antes el customerCode llevaba el CONTRATO; ahora el customerCode
 * lleva el CLIENTE y el contrato pasa al addressCode.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassDispatchAttemptRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { MissingRequiredFieldsError } from '../../domain/errors/scheduling';
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

describe('SendTaskToIClass — #121 customer=client / contract=address', () => {
  it('customer task with contract → customerCode = CLIENT, addressCode = CONTRACT', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { contractCode: 'CTR-204382', customerCode: 'CLI-99' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    const input = iclass.createdOrders[0].input;
    // customerCode now identifies the CLIENT (was the CONTRACT pre-#121).
    expect(input.customerCode).toBe('CLI-99');
    // addressCode now carries the CONTRACT (stable, groups addresses per contract).
    expect(input.addressCode).toBe('CTR-204382');
  });

  it('customer task without contract → addressCode falls back to customerCode (NOT the soCode)', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { contractCode: null, customerCode: 'CLI-99' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    const input = iclass.createdOrders[0].input;
    expect(input.customerCode).toBe('CLI-99');
    // Fallback to the client code — stable. NEVER the unique soCode.
    expect(input.addressCode).toBe('CLI-99');
    expect(input.addressCode).not.toBe(input.soCode);
  });

  it('two OS of the SAME contract → same addressCode, different soCode (grouped address, #121 core)', async () => {
    const { tasks, iclass, useCase } = setup();
    // Two tasks, same client + same contract — they must share ONE address in IClass.
    fullTask(tasks, { id: 't1', contractCode: 'CTR-777', customerCode: 'CLI-99' });
    fullTask(tasks, { id: 't2', contractCode: 'CTR-777', customerCode: 'CLI-99' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);
    await useCase.execute('t2', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(2);
    const [a, b] = iclass.createdOrders.map(o => o.input);
    // Same contract → same addressCode → IClass keeps ONE address for the contract.
    expect(a.addressCode).toBe('CTR-777');
    expect(b.addressCode).toBe('CTR-777');
    expect(a.addressCode).toBe(b.addressCode);
    // But each OS has its own soCode (= sequenceNumber, matching key for closure).
    expect(a.soCode).not.toBe(b.soCode);
  });

  it('soCode stays = sequenceNumber (closure matching key intact)', async () => {
    const { tasks, iclass, useCase } = setup();
    const task = fullTask(tasks, { contractCode: 'CTR-204382', customerCode: 'CLI-99' });

    await useCase.execute('t1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders[0].input.soCode).toBe(String(task.sequenceNumber));
  });
});

describe('SendTaskToIClass — #121 WARNING #1: guard against null customer/contract codes', () => {
  it('customer task with contractCode AND customerCode both null → throws, does NOT create OS', async () => {
    const { tasks, iclass, useCase } = setup();
    // All 5 required fields present (so it passes that validation), but BOTH codes are
    // null/blank → without a guard, customerCode+addressCode would leak null to IClass.
    fullTask(tasks, { contractCode: null, customerCode: null });

    await expect(useCase.execute('t1', ENVIAR_STAGE.id, WF)).rejects.toBeInstanceOf(
      MissingRequiredFieldsError,
    );

    // The OS must NEVER be created with null codes.
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('customer task with blank-string codes (whitespace) → throws, does NOT create OS', async () => {
    const { tasks, iclass, useCase } = setup();
    fullTask(tasks, { contractCode: '   ', customerCode: '  ' });

    await expect(useCase.execute('t1', ENVIAR_STAGE.id, WF)).rejects.toBeInstanceOf(
      MissingRequiredFieldsError,
    );
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('dispatchToIClass records the validation failure as an attempt (best-effort)', async () => {
    // The guard lives in the shared dispatch helper. When an attempts repo is wired,
    // the failure must be recorded like every other dispatch failure (AD-6).
    const { dispatchToIClass } = await import('../../application/use-cases/dispatchTaskToIClass');
    const { tasks, iclass } = setup();
    const attempts = new InMemoryIClassDispatchAttemptRepository();
    const task = fullTask(tasks, { contractCode: null, customerCode: null });

    await expect(
      dispatchToIClass(
        { tasks, iclass, attempts },
        task,
        'INSTALL',
        'Rosario',
        { workflowId: WF, actorId: null },
      ),
    ).rejects.toBeInstanceOf(MissingRequiredFieldsError);

    expect(iclass.createdOrders).toHaveLength(0);
    const recorded = await attempts.listByTask(task.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.outcome).toBe('error');
  });
});
