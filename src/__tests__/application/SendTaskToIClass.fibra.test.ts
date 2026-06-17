/**
 * #66 — SendTaskToIClass dispatch for fibra network tasks.
 *
 * REQ-FIBRA-DISPATCH-1: fibra task → nodeCode = iclassCityCode
 * REQ-FIBRA-DISPATCH-2: fibra task → customerCode = iclassCityCode
 * REQ-FIBRA-DISPATCH-3: fibra task → customerName = networkSiteName (free-text)
 * REQ-FIBRA-DISPATCH-4: fibra task → address = firstNonBlank(task.address, task.networkSiteName)
 * REQ-FIBRA-DISPATCH-5: fibra task → city = iclassCityCode
 * REQ-FIBRA-DISPATCH-6: fibra task → networkSite NOT looked up (networkSiteId null)
 * REQ-RED-DISPATCH-UNCHANGED: red tasks use existing behavior (site.iclassNodeCode, site fields)
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
const WF = 'wf-fibra';

const ENVIAR_STAGE: Stage = {
  id: 'stage-enviar', workflowId: WF, name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5, color: null,
};
const REGISTRADO_STAGE: Stage = {
  id: 'stage-registrado', workflowId: WF, name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null,
};
const DEFAULT_SO_TYPE = { id: 'so-type-1', code: 'MANTENIMIENTO', active: true };
const DEFAULT_PROJECT_ID = 'proj-fibra-1';

function makeSite(overrides: Partial<NetworkSite> & { id: string; name: string }): NetworkSite {
  return {
    siteNumber: 1,
    fixedCode: 'NODO 1',
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
    uispSiteId: null,
    ...overrides,
  };
}

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);
  tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'FO', iclassSoType: DEFAULT_SO_TYPE });

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, true);

  const iclass = new InMemoryIClassClient();
  iclass.nodes = [];

  // NetworkSiteRepository: has a site but fibra tasks should NOT use it
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([
    makeSite({ id: 'site-red-1', name: 'Torre Norte', iclassNodeCode: 'TN-RED', city: 'Rosario' }),
  ]);

  const useCase = new SendTaskToIClass(tasks, flags, iclass, undefined, undefined, networkSiteRepo);
  return { tasks, stages, flags, iclass, useCase, networkSiteRepo };
}

describe('SendTaskToIClass — fibra task dispatch (#66)', () => {
  it('REQ-FIBRA-DISPATCH-1/2/5: nodeCode, customerCode, city = iclassCityCode', async () => {
    const { tasks, iclass, useCase } = setup();
    tasks.seedTask({
      id: 'task-fibra-1',
      stageId: ENVIAR_STAGE.id,
      kind: 'network',
      networkType: 'fibra',
      networkSiteId: null,
      networkSiteName: 'Nodo FO-1',
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCode: null,
      address: 'Calle FO 100',
      description: 'Instalación FO',
      projectId: DEFAULT_PROJECT_ID,
      iclassCityCode: 'Mercedes',
    });

    await useCase.execute('task-fibra-1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    const order = iclass.createdOrders[0].input;
    expect(order.nodeCode).toBe('Mercedes');
    expect(order.customerCode).toBe('Mercedes');
    expect(order.city).toBe('Mercedes');
    // #121 — addressCode = the city/node code (stable), NOT the unique soCode.
    expect(order.addressCode).toBe('Mercedes');
    expect(order.addressCode).not.toBe(order.soCode);
  });

  it('REQ-FIBRA-DISPATCH-3: customerName = networkSiteName', async () => {
    const { tasks, iclass, useCase } = setup();
    tasks.seedTask({
      id: 'task-fibra-2',
      stageId: ENVIAR_STAGE.id,
      kind: 'network',
      networkType: 'fibra',
      networkSiteId: null,
      networkSiteName: 'Nodo FO-2',
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCode: null,
      address: 'Calle FO 200',
      description: 'Instalación FO',
      projectId: DEFAULT_PROJECT_ID,
      iclassCityCode: 'Rosario',
    });

    await useCase.execute('task-fibra-2', ENVIAR_STAGE.id, WF);

    const order = iclass.createdOrders[0].input;
    expect(order.customerName).toBe('Nodo FO-2');
  });

  it('REQ-FIBRA-DISPATCH-4: address = task.address when present', async () => {
    const { tasks, iclass, useCase } = setup();
    tasks.seedTask({
      id: 'task-fibra-3',
      stageId: ENVIAR_STAGE.id,
      kind: 'network',
      networkType: 'fibra',
      networkSiteId: null,
      networkSiteName: 'Nodo FO-3',
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCode: null,
      address: 'Av. Fibra Óptica 999',
      description: 'Instalación FO',
      projectId: DEFAULT_PROJECT_ID,
      iclassCityCode: 'Córdoba',
    });

    await useCase.execute('task-fibra-3', ENVIAR_STAGE.id, WF);

    const order = iclass.createdOrders[0].input;
    expect(order.address).toBe('Av. Fibra Óptica 999');
  });

  it('REQ-FIBRA-DISPATCH-4b: address falls back to networkSiteName when task.address is blank', async () => {
    const { tasks, iclass, useCase } = setup();
    tasks.seedTask({
      id: 'task-fibra-4',
      stageId: ENVIAR_STAGE.id,
      kind: 'network',
      networkType: 'fibra',
      networkSiteId: null,
      networkSiteName: 'Nodo FO-4',
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCode: null,
      address: null,
      description: 'Instalación FO',
      projectId: DEFAULT_PROJECT_ID,
      iclassCityCode: 'Mendoza',
    });

    await useCase.execute('task-fibra-4', ENVIAR_STAGE.id, WF);

    const order = iclass.createdOrders[0].input;
    expect(order.address).toBe('Nodo FO-4');
  });

  it('REQ-FIBRA-DISPATCH-6: networkSite is NOT looked up for fibra tasks', async () => {
    const { tasks, iclass, useCase, networkSiteRepo } = setup();
    const findByIdSpy = jest.spyOn(networkSiteRepo, 'findById');

    tasks.seedTask({
      id: 'task-fibra-5',
      stageId: ENVIAR_STAGE.id,
      kind: 'network',
      networkType: 'fibra',
      networkSiteId: null,
      networkSiteName: 'Nodo FO-5',
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCode: null,
      address: 'Calle FO 500',
      description: 'Instalación FO',
      projectId: DEFAULT_PROJECT_ID,
      iclassCityCode: 'Salta',
    });

    await useCase.execute('task-fibra-5', ENVIAR_STAGE.id, WF);

    expect(findByIdSpy).not.toHaveBeenCalled();
    expect(iclass.createdOrders).toHaveLength(1);
  });
});

describe('SendTaskToIClass — red task UNCHANGED behavior (#66 regression)', () => {
  it('REQ-RED-DISPATCH-UNCHANGED: red task still uses site.iclassNodeCode as nodeCode', async () => {
    const stages = new InMemoryStageRepository();
    stages.addDirect(ENVIAR_STAGE);
    stages.addDirect(REGISTRADO_STAGE);

    const tasks = new InMemorySchedulingRepository(stages);
    tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'Red', iclassSoType: DEFAULT_SO_TYPE });

    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);

    const iclass = new InMemoryIClassClient();
    iclass.nodes = [];

    const networkSiteRepo = new InMemoryNetworkSiteRepository();
    networkSiteRepo.seedSites([
      makeSite({ id: 'site-red-rg', name: 'Torre Norte', iclassNodeCode: 'TN-RED-001', city: 'Mercedes', address: 'Ruta 7' }),
    ]);

    const useCase = new SendTaskToIClass(tasks, flags, iclass, undefined, undefined, networkSiteRepo);

    tasks.seedTask({
      id: 'task-red-rg',
      stageId: ENVIAR_STAGE.id,
      kind: 'network',
      networkType: 'red',
      networkSiteId: 'site-red-rg',
      networkSiteName: 'Torre Norte',
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCode: null,
      address: null,
      description: 'Mantenimiento red',
      projectId: DEFAULT_PROJECT_ID,
      iclassCityCode: 'Mercedes',
    });

    await useCase.execute('task-red-rg', ENVIAR_STAGE.id, WF);

    const order = iclass.createdOrders[0].input;
    expect(order.nodeCode).toBe('TN-RED-001');       // site.iclassNodeCode — unchanged
    expect(order.customerName).toBe('Torre Norte');   // site.name via JOIN — unchanged
    expect(order.city).toBe('Mercedes');              // iclassCityCode wins over site.city — #54
  });
});
