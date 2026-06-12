/**
 * #54 — SendTaskToIClass locality precedence for network tasks.
 *
 * REQ-LOC-DISPATCH-1: task.iclassCityCode set + site.city different → OS city == task.iclassCityCode (override wins)
 * REQ-LOC-DISPATCH-2: task.iclassCityCode null + site.city set → OS city == site.city (fallback, back-compat)
 * REQ-LOC-DISPATCH-3: both null → MissingRequiredFieldsError includes 'city' (old behavior preserved)
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { MissingRequiredFieldsError } from '../../domain/errors/scheduling';
import { Stage } from '../../domain/entities/workflow';
import { NetworkSite } from '../../domain/entities/networkSite';

const FLAG_KEY = 'iclass-integration';
const WF = 'wf-loc';

const ENVIAR_STAGE: Stage = {
  id: 'stage-enviar', workflowId: WF, name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5, color: null,
};
const REGISTRADO_STAGE: Stage = {
  id: 'stage-registrado', workflowId: WF, name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null,
};
const DEFAULT_SO_TYPE = { id: 'so-type-1', code: 'MANTENIMIENTO', active: true };
const DEFAULT_PROJECT_ID = 'proj-loc-1';

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
    uispSiteId: null,
    ...overrides,
  };
}

function setup(siteCity = 'Mercedes') {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);
  tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'Nodos', iclassSoType: DEFAULT_SO_TYPE });

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, true);

  const iclass = new InMemoryIClassClient();
  iclass.nodes = [];

  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([
    makeSite({ id: 'site-loc-1', name: 'Torre Loc', city: siteCity }),
  ]);

  const useCase = new SendTaskToIClass(tasks, flags, iclass, undefined, undefined, networkSiteRepo);
  return { tasks, stages, flags, iclass, useCase, networkSiteRepo };
}

function seedNetworkTaskWithLocality(
  tasks: InMemorySchedulingRepository,
  iclassCityCode: string | null,
  taskId = 'task-loc-1',
) {
  return tasks.seedTask({
    id: taskId,
    stageId: ENVIAR_STAGE.id,
    kind: 'network',
    networkSiteId: 'site-loc-1',
    networkSiteName: 'Torre Loc',
    customerId: null,
    customerName: null,
    customerPhone: null,
    customerCity: null,
    customerCode: null,
    address: 'Ruta 7 km 5',
    description: 'Mantenimiento preventivo',
    projectId: DEFAULT_PROJECT_ID,
    iclassCityCode,
  });
}

describe('SendTaskToIClass — locality precedence (task.iclassCityCode ?? site.city) (#54)', () => {
  it('REQ-LOC-DISPATCH-1: task.iclassCityCode set + site.city different → OS city == task.iclassCityCode (override wins)', async () => {
    // site.city='Mercedes', task.iclassCityCode='Rosario' → city should be 'Rosario'
    const { tasks, iclass, useCase } = setup('Mercedes');
    seedNetworkTaskWithLocality(tasks, 'Rosario');

    await useCase.execute('task-loc-1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    const order = iclass.createdOrders[0].input;
    expect(order.city).toBe('Rosario');
  });

  it('REQ-LOC-DISPATCH-2: task.iclassCityCode=null + site.city set → OS city == site.city (fallback, back-compat)', async () => {
    // task.iclassCityCode=null, site.city='Mercedes' → city should be 'Mercedes'
    const { tasks, iclass, useCase } = setup('Mercedes');
    seedNetworkTaskWithLocality(tasks, null, 'task-loc-2');

    await useCase.execute('task-loc-2', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    const order = iclass.createdOrders[0].input;
    expect(order.city).toBe('Mercedes');
  });

  it('REQ-ADDR-DISPATCH-1: site has no address + task.address set → OS address == task.address (#53 fix)', async () => {
    // The shared dispatch helper must honour task.address (the address #53 forces on
    // create) when the site itself has no address — otherwise it fell back to
    // networkSiteName and the address never reached IClass.
    const { tasks, iclass, useCase, networkSiteRepo } = setup('Mercedes');
    networkSiteRepo.seedSites([makeSite({ id: 'site-loc-1', name: 'Torre Loc', city: 'Mercedes', address: '' })]);
    seedNetworkTaskWithLocality(tasks, 'Mercedes', 'task-addr-1');

    await useCase.execute('task-addr-1', ENVIAR_STAGE.id, WF);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(iclass.createdOrders[0].input.address).toBe('Ruta 7 km 5');
  });

  it('REQ-LOC-DISPATCH-3: both blank → MissingRequiredFieldsError includes city', async () => {
    // task.iclassCityCode=null, site.city='' (blank) → MissingRequiredFieldsError with city
    // NetworkSite.city is typed as string (not nullable) — use empty string to simulate missing.
    const { tasks, useCase } = setup('');
    seedNetworkTaskWithLocality(tasks, null, 'task-loc-3');

    let caught: unknown;
    try {
      await useCase.execute('task-loc-3', ENVIAR_STAGE.id, WF);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingRequiredFieldsError);
    expect((caught as MissingRequiredFieldsError).missingFields).toContain('city');
  });
});
