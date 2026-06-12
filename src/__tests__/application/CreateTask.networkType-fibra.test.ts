/**
 * #66 — CreateTask guard for fibra network tasks.
 *
 * REQ-FIBRA-CREATE-1: fibra task + networkSiteId non-null → 422 (fibra cannot have a site FK)
 * REQ-FIBRA-CREATE-2: fibra task + blank networkSiteName → NetworkTaskNodeNameRequiredError
 * REQ-FIBRA-CREATE-3: fibra task + blank iclassCityCode → NetworkTaskLocalityRequiredError
 * REQ-FIBRA-CREATE-4: fibra task + valid name + locality → resolves ok, no networkSiteId
 * REQ-FIBRA-CREATE-5: fibra task + valid inputs → networkSiteName persisted
 * REQ-RED-CREATE-1: red task (explicit networkType='red') + no locality → resolves ok (locality optional for red)
 * REQ-RED-CREATE-2: red task (networkType omitted) + no locality → resolves ok (backward compat)
 * REQ-RED-CREATE-3: red task + missing networkSiteId → ReferenceNotFoundError
 */
import { CreateTask } from '../../application/use-cases/CreateTask';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import {
  NetworkTaskLocalityRequiredError,
  NetworkTaskNodeNameRequiredError,
  ReferenceNotFoundError,
} from '../../domain/errors/scheduling';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../domain/ports/ProjectKindLookup';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

class EmptyProjectLookup implements ProjectKindLookup {
  async findById() { return null; }
}

function buildUseCase() {
  const repo = new InMemorySchedulingRepository();
  // InMemoryNetworkSiteRepository seeds id='1' by default
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  const useCase = new CreateTask(
    repo,
    new AnyLookup(),
    new AnyLookup(),
    new AnyLookup(),
    new AnyLookup(),
    new EmptyProjectLookup(),
    undefined,
    undefined,
    networkSiteRepo,
  );
  return { repo, useCase };
}

// Shared base for fibra tasks — no networkSiteId, no networkType defaults to 'fibra'
const FIBRA_BASE = {
  title: 'Fibra task',
  priority: 'normal',
  estimatedHours: 2,
  category: 'maintenance' as const,
  kind: 'network' as const,
  networkType: 'fibra' as const,
  networkSiteId: null,
  customerId: null,
  contractId: null,
  address: 'Ruta 7 km 5',
  stageId: '10000000-0000-4000-a000-000000000001',
  description: null,
  coordinates: null,
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

// Shared base for red tasks — matches old network task pattern
const RED_BASE = {
  title: 'Red task',
  priority: 'normal',
  estimatedHours: 2,
  category: 'maintenance' as const,
  kind: 'network' as const,
  networkSiteId: '1',   // seeded in InMemoryNetworkSiteRepository
  customerId: null,
  contractId: null,
  address: 'Ruta 7 km 5',
  stageId: '10000000-0000-4000-a000-000000000001',
  description: null,
  coordinates: null,
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

describe('CreateTask — fibra tasks (#66)', () => {
  it('REQ-FIBRA-CREATE-2: fibra + blank networkSiteName → NetworkTaskNodeNameRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...FIBRA_BASE, networkSiteName: '', iclassCityCode: 'Mercedes' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskNodeNameRequiredError);
  });

  it('REQ-FIBRA-CREATE-2b: fibra + null networkSiteName → NetworkTaskNodeNameRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...FIBRA_BASE, networkSiteName: null, iclassCityCode: 'Mercedes' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskNodeNameRequiredError);
  });

  it('REQ-FIBRA-CREATE-2c: fibra + whitespace networkSiteName → NetworkTaskNodeNameRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...FIBRA_BASE, networkSiteName: '   ', iclassCityCode: 'Mercedes' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskNodeNameRequiredError);
  });

  it('REQ-FIBRA-CREATE-3: fibra + blank iclassCityCode → NetworkTaskLocalityRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...FIBRA_BASE, networkSiteName: 'Nodo FO-1', iclassCityCode: null } as never),
    ).rejects.toBeInstanceOf(NetworkTaskLocalityRequiredError);
  });

  it('REQ-FIBRA-CREATE-3b: fibra + empty iclassCityCode → NetworkTaskLocalityRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...FIBRA_BASE, networkSiteName: 'Nodo FO-1', iclassCityCode: '' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskLocalityRequiredError);
  });

  it('REQ-FIBRA-CREATE-4: fibra + valid name + locality → resolves ok, networkSiteId null', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({
      ...FIBRA_BASE,
      networkSiteName: 'Nodo FO-1',
      iclassCityCode: 'Mercedes',
    } as never);
    expect(task.id).toBeTruthy();
    expect(task.networkSiteId).toBeNull();
    expect(task.networkType).toBe('fibra');
  });

  it('REQ-FIBRA-CREATE-5: fibra task → networkSiteName persisted on the task', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({
      ...FIBRA_BASE,
      networkSiteName: 'Nodo FO-1',
      iclassCityCode: 'Mercedes',
    } as never);
    expect(task.networkSiteName).toBe('Nodo FO-1');
  });
});

describe('CreateTask — red tasks locality relaxed (#66)', () => {
  it('REQ-RED-CREATE-1: red (explicit networkType=red) + iclassCityCode=null → resolves ok', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({
      ...RED_BASE,
      networkType: 'red' as const,
      iclassCityCode: null,
    } as never);
    expect(task.id).toBeTruthy();
    expect(task.networkType).toBe('red');
  });

  it('REQ-RED-CREATE-2: red (networkType omitted → defaults to red) + iclassCityCode=null → resolves ok', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({
      ...RED_BASE,
      iclassCityCode: null,
    } as never);
    expect(task.id).toBeTruthy();
  });

  it('REQ-RED-CREATE-3: red + networkSiteId not found → ReferenceNotFoundError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...RED_BASE, networkSiteId: 'nonexistent', iclassCityCode: null } as never),
    ).rejects.toBeInstanceOf(ReferenceNotFoundError);
  });
});
