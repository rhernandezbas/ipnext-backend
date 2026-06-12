/**
 * #53 — UpdateTask address guard for network tasks.
 *
 * REQ-ADDR-UPDATE-1: update network task sending address='' → NetworkTaskAddressRequiredError
 * REQ-ADDR-UPDATE-2: update network task NOT sending address → ok (partial update)
 * REQ-ADDR-UPDATE-3: update customer task to address='' → ok (guard only applies to network)
 *
 * NOTE on in-memory id collisions: InMemorySchedulingRepository pre-seeds tasks
 * with ids '1'–'7', and nextId (module-level) starts at 7. The first createTask()
 * call in this file produces id '7' — which collides with the pre-seeded task '7'
 * (kind='customer'). To avoid this, we use a shared setup across all tests:
 * we create one dummy customer task first (consuming id '7'), then the real
 * network task (gets id '8', no collision), and share them across all `it()` blocks.
 */
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { NetworkTaskAddressRequiredError } from '../../domain/errors/scheduling';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../domain/ports/ProjectKindLookup';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

class EmptyProjectLookup implements ProjectKindLookup {
  async findById() { return null; }
}

const BASE_TASK = {
  title: 'task',
  priority: 'normal',
  estimatedHours: 2,
  stageId: '10000000-0000-4000-a000-000000000001',
  description: null,
  address: 'Some Street 123',
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

describe('UpdateTask — address guard for network tasks (#53)', () => {
  let repo: InMemorySchedulingRepository;
  let useCase: UpdateTask;
  let networkTaskId: string;
  let customerTaskId: string;

  beforeAll(async () => {
    repo = new InMemorySchedulingRepository();
    useCase = new UpdateTask(
      repo,
      new AnyLookup(),
      new AnyLookup(),
      new AnyLookup(),
      new AnyLookup(),
      new EmptyProjectLookup(),
      undefined,
    );

    // Consume id '7' (would collide with pre-seeded task '7') with a dummy customer task.
    // This advances nextId to 8, avoiding the collision for subsequent seeds.
    await repo.createTask({ ...BASE_TASK, category: 'installation', kind: 'customer', customerId: 'c-dummy', contractId: 'ct-dummy', networkSiteId: null } as never);

    // Network task gets id '8' — no collision with pre-seeded tasks.
    const networkTask = await repo.createTask({ ...BASE_TASK, category: 'maintenance', kind: 'network', networkSiteId: '1', customerId: null, contractId: null } as never);
    networkTaskId = networkTask.id;

    // Customer task gets id '9'.
    const customerTask = await repo.createTask({ ...BASE_TASK, category: 'installation', kind: 'customer', customerId: 'c-1', contractId: 'ct-1', networkSiteId: null } as never);
    customerTaskId = customerTask.id;
  });

  it('update network task with address="" → rejects NetworkTaskAddressRequiredError', async () => {
    await expect(
      useCase.execute(networkTaskId, { address: '' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskAddressRequiredError);
  });

  it('update network task with address="   " (whitespace) → rejects NetworkTaskAddressRequiredError', async () => {
    await expect(
      useCase.execute(networkTaskId, { address: '   ' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskAddressRequiredError);
  });

  it('update network task with address=null → rejects NetworkTaskAddressRequiredError', async () => {
    await expect(
      useCase.execute(networkTaskId, { address: null } as never),
    ).rejects.toBeInstanceOf(NetworkTaskAddressRequiredError);
  });

  it('update network task NOT sending address (undefined) → ok (partial update)', async () => {
    const updated = await useCase.execute(networkTaskId, { title: 'renamed' } as never);
    expect(updated?.title).toBe('renamed');
  });

  it('update customer task with address="" → ok (guard only applies to network)', async () => {
    const updated = await useCase.execute(customerTaskId, { address: '' } as never);
    expect(updated).not.toBeNull();
  });
});
