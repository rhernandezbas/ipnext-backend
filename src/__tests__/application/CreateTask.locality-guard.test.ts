/**
 * #54/#66 — CreateTask locality guard for network tasks.
 *
 * RED tasks (#66 relaxation): locality (iclassCityCode) is now OPTIONAL.
 *   REQ-LOC-CREATE-1-RED: red network task + blank iclassCityCode → ok (relaxed by #66)
 *   REQ-LOC-CREATE-2: red network task + valid iclassCityCode → ok
 *   REQ-LOC-CREATE-3: customer task + null iclassCityCode → ok (regression)
 *
 * FIBRA tasks (#66): locality still required.
 *   REQ-LOC-CREATE-FIBRA: fibra task + blank iclassCityCode → NetworkTaskLocalityRequiredError
 *   (more fibra tests in CreateTask.networkType-fibra.test.ts)
 */
import { CreateTask } from '../../application/use-cases/CreateTask';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { NetworkTaskLocalityRequiredError } from '../../domain/errors/scheduling';
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
  // InMemoryNetworkSiteRepository seeds id='1' by default — matches NETWORK_BASE.networkSiteId
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  const useCase = new CreateTask(
    repo,
    new AnyLookup(),          // customerLookup
    new AnyLookup(),          // contractLookup
    new AnyLookup(),          // partnerLookup
    new AnyLookup(),          // adminLookup
    new EmptyProjectLookup(), // projectLookup
    undefined,                // ticketLookup
    undefined,                // recorder
    networkSiteRepo,
  );
  return { repo, useCase };
}

const NETWORK_BASE = {
  title: 'Network task',
  priority: 'normal',
  estimatedHours: 2,
  category: 'maintenance' as const,
  kind: 'network' as const,
  networkSiteId: '1',   // seeded in InMemoryNetworkSiteRepository
  customerId: null,
  contractId: null,
  address: 'Ruta 7 km 5',  // #53 address required — must be non-blank for network tasks
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

const CUSTOMER_BASE = {
  title: 'Customer task',
  priority: 'normal',
  estimatedHours: 2,
  category: 'installation' as const,
  kind: 'customer' as const,
  customerId: 'c-1',
  contractId: 'ct-1',
  stageId: '10000000-0000-4000-a000-000000000001',
  description: null,
  address: null,
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
  networkSiteId: null,
};

describe('CreateTask — locality guard — RED tasks (#54/#66 relaxation)', () => {
  it('REQ-LOC-CREATE-1-RED: red task + iclassCityCode=null → now RESOLVES ok (locality relaxed for red in #66)', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({ ...NETWORK_BASE, networkType: 'red' as const, iclassCityCode: null } as never);
    expect(task.id).toBeTruthy();
  });

  it('red task + iclassCityCode="" → now RESOLVES ok (locality relaxed for red in #66)', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({ ...NETWORK_BASE, networkType: 'red' as const, iclassCityCode: '' } as never);
    expect(task.id).toBeTruthy();
  });

  it('red task (networkType omitted) + iclassCityCode=null → resolves ok (back-compat)', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({ ...NETWORK_BASE, iclassCityCode: null } as never);
    expect(task.id).toBeTruthy();
  });

  it('red network task + valid iclassCityCode → resolves with id truthy', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({ ...NETWORK_BASE, iclassCityCode: 'Mercedes' } as never);
    expect(task.id).toBeTruthy();
    expect(task.iclassCityCode).toBe('Mercedes');
  });

  it('customer task + iclassCityCode=null → still resolves (locality is optional for customers)', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({ ...CUSTOMER_BASE, iclassCityCode: null } as never);
    expect(task.id).toBeTruthy();
  });
});

describe('CreateTask — locality guard — FIBRA tasks (#66)', () => {
  const FIBRA_NETWORK_BASE = {
    ...NETWORK_BASE,
    networkType: 'fibra' as const,
    networkSiteId: null,
    networkSiteName: 'Nodo FO-1',
  };

  it('REQ-LOC-CREATE-FIBRA: fibra + iclassCityCode=null → NetworkTaskLocalityRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...FIBRA_NETWORK_BASE, iclassCityCode: null } as never),
    ).rejects.toBeInstanceOf(NetworkTaskLocalityRequiredError);
  });

  it('fibra + iclassCityCode="" → NetworkTaskLocalityRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...FIBRA_NETWORK_BASE, iclassCityCode: '' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskLocalityRequiredError);
  });
});
