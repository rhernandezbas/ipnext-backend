/**
 * A3.1 [RED] Unit tests para CreateTask use case con network-node-task (#29).
 * Cubre REQ-KIND-1, REQ-KIND-2, REQ-KIND-3.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { ReferenceNotFoundError } from '../../domain/errors/scheduling';
import { EntityLookup } from '../../domain/ports/EntityLookup';

// Lookup que acepta cualquier ID
class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

// Lookup vacío (siempre retorna null)
class EmptyLookup implements EntityLookup {
  async findById() { return null; }
}

function buildUseCase(opts?: { networkSiteRepo?: InMemoryNetworkSiteRepository }) {
  const repo = new InMemorySchedulingRepository();
  const networkSiteRepo = opts?.networkSiteRepo ?? new InMemoryNetworkSiteRepository();
  const useCase = new CreateTask(
    repo,
    new AnyLookup(), // customerLookup
    new AnyLookup(), // contractLookup
    new AnyLookup(), // partnerLookup
    new AnyLookup(), // adminLookup
    new AnyLookup(), // projectLookup
    undefined,       // ticketLookup
    undefined,       // recorder
    networkSiteRepo,
  );
  return { repo, networkSiteRepo, useCase };
}

const BASE_CUSTOMER_INPUT = {
  title: 'Instalación fibra',
  priority: 'normal',
  estimatedHours: 2,
  category: 'installation',
  kind: 'customer' as const,
  customerId: 'c-1',
  contractId: 'ct-1',
  stageId: '10000000-0000-4000-a000-000000000001',
  description: null,
  address: null,
  coordinates: null,
  projectId: null,
  projectName: null,
  completedAt: null,
  notes: null,
  startDate: null,
  endDate: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  travelTimeTo: null,
  travelTimeFrom: null,
  networkSiteId: null,
};

const BASE_NETWORK_INPUT = {
  title: 'Mantenimiento Torre Norte',
  priority: 'normal',
  estimatedHours: 3,
  category: 'maintenance',
  kind: 'network' as const,
  networkSiteId: '1', // ID de 'Nodo Central' en InMemoryNetworkSiteRepository
  customerId: null,
  contractId: null,
  stageId: '10000000-0000-4000-a000-000000000001',
  description: null,
  // #53/#54 — address + locality required for network tasks.
  address: 'Ruta 7 km 5',
  iclassCityCode: 'Mercedes',
  coordinates: null,
  projectId: null,
  projectName: null,
  completedAt: null,
  notes: null,
  startDate: null,
  endDate: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  travelTimeTo: null,
  travelTimeFrom: null,
};

describe('CreateTask — customer branch (REQ-KIND-1 regression)', () => {
  it('crea una tarea de tipo customer sin problemas', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute(BASE_CUSTOMER_INPUT);
    expect(task.id).toBeTruthy();
    expect(task.kind).toBe('customer');
    expect(task.networkSiteId).toBeNull();
  });
});

describe('CreateTask — network branch (REQ-KIND-1)', () => {
  it('crea una tarea de RED con networkSiteId válido', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute(BASE_NETWORK_INPUT);
    expect(task.id).toBeTruthy();
    expect(task.kind).toBe('network');
    expect(task.networkSiteId).toBe('1');
  });

  it('networkSiteId inexistente lanza ReferenceNotFoundError (REQ-KIND-3)', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...BASE_NETWORK_INPUT, networkSiteId: 'does-not-exist' }),
    ).rejects.toMatchObject({
      name: 'ReferenceNotFoundError',
      kind: 'networkSite',
      id: 'does-not-exist',
    });
  });

  it('NO llama a customerLookup ni contractLookup en modo network', async () => {
    // Si intentara buscar customer/contract con null, el test fallaría porque
    // CreateTask no debería hacer esas validaciones en modo network.
    // Usamos EmptyLookup para customer/contract: si los intenta, lanza error.
    const repo = new InMemorySchedulingRepository();
    const networkSiteRepo = new InMemoryNetworkSiteRepository();
    const useCase = new CreateTask(
      repo,
      new EmptyLookup(), // customerLookup — lanzaría error si se llama con null
      new EmptyLookup(), // contractLookup — idem
      new AnyLookup(),
      new AnyLookup(),
      new AnyLookup(),
      undefined,
      undefined,
      networkSiteRepo,
    );
    // No debería rechazar — customerId/contractId son null y no deben validarse
    const task = await useCase.execute(BASE_NETWORK_INPUT);
    expect(task.kind).toBe('network');
  });
});
