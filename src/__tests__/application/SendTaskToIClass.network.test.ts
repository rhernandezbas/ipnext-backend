/**
 * A5.1 [RED] Tests para SendTaskToIClass con tareas de RED (network-node-task #29).
 * Cubre: REQ-NODE-DISPATCH-1, REQ-NODE-DISPATCH-2, REQ-NODE-DISPATCH-3, REQ-PORT-1.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { Stage } from '../../domain/entities/workflow';
import { NetworkSite } from '../../domain/entities/networkSite';

const FLAG_KEY = 'iclass-integration';
const WF = 'wf-net';

const ENVIAR_STAGE: Stage = {
  id: 'stage-enviar', workflowId: WF, name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5, color: null,
};
const REGISTRADO_STAGE: Stage = {
  id: 'stage-registrado', workflowId: WF, name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null,
};
const DEFAULT_SO_TYPE = { id: 'so-type-1', code: 'MANTENIMIENTO', active: true };
const DEFAULT_PROJECT_ID = 'proj-net-1';

/** Crea un NetworkSite de prueba listo para insertar en el repo. */
function makeSite(overrides: Partial<NetworkSite> & { id: string; name: string }): NetworkSite {
  return {
    address: 'Dirección por defecto 123',
    city: 'Mercedes',
    coordinates: null,
    type: 'nodo',
    status: 'active',
    deviceCount: 0,
    clientCount: 0,
    uplink: '1 Gbps',
    parentSiteId: null,
    description: '',
    iclassNodeCode: 'TN-001',
    ...overrides,
  };
}

function setup(opts?: { siteOverrides?: Partial<NetworkSite> }) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);
  tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'Nodos', iclassSoType: DEFAULT_SO_TYPE });

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, true);

  const iclass = new InMemoryIClassClient();
  // Nodo no es necesario para tareas de RED (listNodes no se llama)
  iclass.nodes = [];

  // NetworkSiteRepository con el sitio de test
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([
    makeSite({ id: 'site-1', name: 'Torre Norte', ...opts?.siteOverrides }),
  ]);

  const useCase = new SendTaskToIClass(tasks, flags, iclass, undefined, undefined, networkSiteRepo);
  return { tasks, stages, flags, iclass, useCase, networkSiteRepo };
}

/**
 * Seed a network task. networkSiteId='site-1' apunta al sitio pre-cargado en setup().
 */
function seedNetworkTask(
  tasks: InMemorySchedulingRepository,
  opts: {
    networkSiteId?: string;
    networkSiteName?: string;
    id?: string;
  } = {},
) {
  return tasks.seedTask({
    id: opts.id ?? 'task-net-1',
    stageId: ENVIAR_STAGE.id,
    kind: 'network',
    networkSiteId: opts.networkSiteId ?? 'site-1',
    networkSiteName: opts.networkSiteName ?? 'Torre Norte',
    customerId: null,
    customerName: null,
    customerPhone: null,
    customerCity: null,
    customerCode: null,
    address: null,
    description: 'Mantenimiento preventivo',
    projectId: DEFAULT_PROJECT_ID,
  });
}

describe('SendTaskToIClass — network task dispatch (REQ-NODE-DISPATCH-1)', () => {
  it('dispatches network task with substituted fields (customerName=site, phone=0000000000)', async () => {
    // site-1 en setup() tiene: name='Torre Norte', iclassNodeCode='TN-001', address=..., city='Mercedes'
    const { tasks, iclass, useCase } = setup({
      siteOverrides: { name: 'Torre Norte', iclassNodeCode: 'TN-001', address: 'Ruta 7 km 5', city: 'Mercedes' },
    });
    seedNetworkTask(tasks, { networkSiteName: 'Torre Norte' });

    const result = await useCase.execute('task-net-1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    const order = iclass.createdOrders[0].input;
    expect(order.customerName).toBe('Torre Norte');
    expect(order.phone).toBe('0000000000');
    expect(order.soType).toBe('MANTENIMIENTO');
  });

  it('listNodes() is NOT called for network tasks (REQ-PORT-1)', async () => {
    const { tasks, iclass, useCase } = setup();
    const listNodesSpy = jest.spyOn(iclass, 'listNodes');
    seedNetworkTask(tasks);

    await useCase.execute('task-net-1', ENVIAR_STAGE.id, WF);

    expect(listNodesSpy).not.toHaveBeenCalled();
  });

  it('iclassNodeCode=null falls back to NETWORK for customerCode and nodeCode (REQ-NODE-DISPATCH-3)', async () => {
    const { tasks, iclass, useCase } = setup({ siteOverrides: { iclassNodeCode: null } });
    seedNetworkTask(tasks, { networkSiteName: 'Nodo Sin Código' });

    await useCase.execute('task-net-1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    const order = iclass.createdOrders[0].input;
    expect(order.customerCode).toBe('NETWORK');
    expect(order.nodeCode).toBe('NETWORK');
  });
});

describe('SendTaskToIClass — customer task regression (REQ-NODE-DISPATCH-1)', () => {
  it('customer task still calls listNodes() city-match', async () => {
    const stagesRepo = new InMemoryStageRepository();
    stagesRepo.addDirect(ENVIAR_STAGE);
    stagesRepo.addDirect(REGISTRADO_STAGE);

    const tasks = new InMemorySchedulingRepository(stagesRepo);
    tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'Proyecto', iclassSoType: DEFAULT_SO_TYPE });

    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);

    const iclass = new InMemoryIClassClient();
    iclass.nodes = [{ code: 'Mercedes', description: 'Mercedes' }];

    const useCase = new SendTaskToIClass(tasks, flags, iclass);
    const listNodesSpy = jest.spyOn(iclass, 'listNodes');

    tasks.seedTask({
      id: 'task-cust-1',
      stageId: ENVIAR_STAGE.id,
      kind: 'customer',
      customerId: 'c-1',
      customerName: 'Juan Pérez',
      customerPhone: '3415550000',
      customerCity: 'Mercedes',
      customerCode: 'GR-001',
      address: 'Calle Falsa 123',
      description: 'Instalar fibra',
      projectId: DEFAULT_PROJECT_ID,
    });

    await useCase.execute('task-cust-1', ENVIAR_STAGE.id, WF);

    expect(listNodesSpy).toHaveBeenCalled();
    expect(iclass.createdOrders).toHaveLength(1);
  });
});

describe('SendTaskToIClass — required field validation on network task (REQ-NODE-DISPATCH-2)', () => {
  it('network task with complete site data passes required-field validation', async () => {
    const { tasks, useCase } = setup({
      siteOverrides: { iclassNodeCode: 'NS-001', address: 'Av. Test 100', city: 'Rosario' },
    });
    seedNetworkTask(tasks, { networkSiteName: 'Nodo Sur' });

    // No debe lanzar MissingRequiredFieldsError
    await expect(useCase.execute('task-net-1', ENVIAR_STAGE.id, WF)).resolves.toBeDefined();
  });

  it('network task with null customerName passes because substitution uses networkSiteName', async () => {
    const { tasks, useCase } = setup();
    // customerName=null pero networkSiteName='Nodo Sur' — debe pasar validación.
    // site-1 ya tiene city='Mercedes' y address='Dirección por defecto 123' del setup.
    tasks.seedTask({
      id: 'task-net-sub',
      stageId: ENVIAR_STAGE.id,
      kind: 'network',
      networkSiteId: 'site-1',
      networkSiteName: 'Nodo Sur',
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCode: null,
      address: null,
      description: 'Revisión preventiva',
      projectId: DEFAULT_PROJECT_ID,
    });

    await expect(useCase.execute('task-net-sub', ENVIAR_STAGE.id, WF)).resolves.toBeDefined();
  });
});
