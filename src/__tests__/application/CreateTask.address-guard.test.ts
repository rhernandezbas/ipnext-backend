/**
 * #53 — CreateTask address guard for network tasks.
 *
 * REQ-ADDR-CREATE-1: network task + blank address (null/empty/whitespace) → NetworkTaskAddressRequiredError
 * REQ-ADDR-CREATE-2: network task + valid address → ok
 * REQ-ADDR-CREATE-3: customer task + null address → ok (regression, address stays optional)
 */
import { CreateTask } from '../../application/use-cases/CreateTask';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { NetworkTaskAddressRequiredError } from '../../domain/errors/scheduling';
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
    new AnyLookup(),         // customerLookup
    new AnyLookup(),         // contractLookup
    new AnyLookup(),         // partnerLookup
    new AnyLookup(),         // adminLookup
    new EmptyProjectLookup(), // projectLookup
    undefined,               // ticketLookup
    undefined,               // recorder
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

describe('CreateTask — address guard for network tasks (#53)', () => {
  it('network task + address=null → rejects NetworkTaskAddressRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...NETWORK_BASE, address: null } as never),
    ).rejects.toBeInstanceOf(NetworkTaskAddressRequiredError);
  });

  it('network task + address="" (empty string) → rejects NetworkTaskAddressRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...NETWORK_BASE, address: '' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskAddressRequiredError);
  });

  it('network task + address="   " (whitespace only) → rejects NetworkTaskAddressRequiredError', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ ...NETWORK_BASE, address: '   ' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskAddressRequiredError);
  });

  it('network task + valid address → resolves with id truthy', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({ ...NETWORK_BASE, address: 'Av. Siempreviva 742' } as never);
    expect(task.id).toBeTruthy();
  });

  it('customer task + address=null → still resolves (address is optional for customers)', async () => {
    const { useCase } = buildUseCase();
    const task = await useCase.execute({ ...CUSTOMER_BASE, address: null } as never);
    expect(task.id).toBeTruthy();
  });
});
