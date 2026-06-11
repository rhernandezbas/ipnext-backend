/**
 * #40 — CreateTask symmetric project↔kind guard.
 *
 * REQ-PROJECT-KIND-GUARD-1/2, REQ-CREATE-12:
 *  - network task + project.isNetworkProject=false → ProjectKindMismatchError
 *  - customer task + project.isNetworkProject=true  → ProjectKindMismatchError
 *  - customer task + project.isNetworkProject=false → ok (no-op proof)
 *  - network task without projectId                → ok (guard bypassed)
 *  - non-existent project                          → ReferenceNotFoundError (NOT kind error)
 */
import { CreateTask } from '../../application/use-cases/CreateTask';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { ReferenceNotFoundError } from '../../domain/errors/scheduling';
import { ProjectKindMismatchError } from '../../domain/errors/scheduling';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../domain/ports/ProjectKindLookup';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

/** Project lookup stub returning a fixed isNetworkProject flag for known ids. */
class StubProjectKindLookup implements ProjectKindLookup {
  constructor(private readonly flags: Record<string, boolean>) {}
  async findById(id: string) {
    if (!(id in this.flags)) return null;
    return { id, isNetworkProject: this.flags[id] };
  }
}

function buildUseCase(projectLookup: ProjectKindLookup) {
  const repo = new InMemorySchedulingRepository();
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  const useCase = new CreateTask(
    repo,
    new AnyLookup(),  // customerLookup
    new AnyLookup(),  // contractLookup
    new AnyLookup(),  // partnerLookup
    new AnyLookup(),  // adminLookup
    projectLookup,    // ProjectKindLookup (6th — widened)
    undefined,        // ticketLookup
    undefined,        // recorder
    networkSiteRepo,
  );
  return { repo, useCase };
}

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

const NETWORK_BASE = {
  title: 'Network task',
  priority: 'normal',
  estimatedHours: 2,
  category: 'maintenance' as const,
  kind: 'network' as const,
  networkSiteId: '1',
  customerId: null,
  contractId: null,
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
};

describe('CreateTask — project↔kind symmetric guard (#40)', () => {
  it('network task + non-network project → ProjectKindMismatchError', async () => {
    const { useCase } = buildUseCase(new StubProjectKindLookup({ 'proj-customer': false }));
    await expect(
      useCase.execute({ ...NETWORK_BASE, projectId: 'proj-customer' } as never),
    ).rejects.toBeInstanceOf(ProjectKindMismatchError);
  });

  it('customer task + network project → ProjectKindMismatchError', async () => {
    const { useCase } = buildUseCase(new StubProjectKindLookup({ 'proj-network': true }));
    await expect(
      useCase.execute({ ...CUSTOMER_BASE, projectId: 'proj-network' } as never),
    ).rejects.toBeInstanceOf(ProjectKindMismatchError);
  });

  it('customer task + customer project → ok (guard no-op when flags align)', async () => {
    const { useCase } = buildUseCase(new StubProjectKindLookup({ 'proj-customer': false }));
    // Must NOT throw — the guard is a no-op when task.kind and project.isNetworkProject align.
    const task = await useCase.execute({ ...CUSTOMER_BASE, projectId: 'proj-customer' } as never);
    expect(task.id).toBeTruthy();
  });

  it('network task + network project → ok', async () => {
    const { useCase } = buildUseCase(new StubProjectKindLookup({ 'proj-network': true }));
    const task = await useCase.execute({ ...NETWORK_BASE, projectId: 'proj-network' } as never);
    expect(task.id).toBeTruthy();
  });

  it('network task WITHOUT projectId → ok (guard bypassed)', async () => {
    const { useCase } = buildUseCase(new StubProjectKindLookup({}));
    const task = await useCase.execute({ ...NETWORK_BASE, projectId: null } as never);
    expect(task.id).toBeTruthy();
  });

  it('non-existent project → ReferenceNotFoundError (NOT a kind error)', async () => {
    const { useCase } = buildUseCase(new StubProjectKindLookup({}));
    await expect(
      useCase.execute({ ...NETWORK_BASE, projectId: 'ghost' } as never),
    ).rejects.toBeInstanceOf(ReferenceNotFoundError);
  });
});
