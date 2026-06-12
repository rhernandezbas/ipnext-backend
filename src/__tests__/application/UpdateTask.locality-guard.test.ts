/**
 * #54/#66 — UpdateTask locality guard for network tasks.
 *
 * #66 changes: RED tasks no longer require locality. Only FIBRA tasks do.
 *
 * RED tasks (networkType='red' or null):
 *   REQ-LOC-UPDATE-RED-1: update red task with blank iclassCityCode → ok (relaxed by #66)
 *   REQ-LOC-UPDATE-2: update network task NOT sending iclassCityCode → ok (partial update)
 *   REQ-LOC-UPDATE-3: update customer task with blank iclassCityCode → ok
 *   REQ-LOC-UPDATE-4: legacy network task (iclassCityCode null) + PUT echoing blank → ok
 *   REQ-LOC-UPDATE-5-FIBRA: FIBRA task WITH locality + PUT blanking it → 422 (still required for fibra)
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
import { NetworkTaskLocalityRequiredError } from '../../domain/errors/scheduling';
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
  iclassCityCode: 'Mercedes',  // valid locality for network tasks
};

describe('UpdateTask — locality guard for network tasks (#54/#66)', () => {
  let repo: InMemorySchedulingRepository;
  let useCase: UpdateTask;
  let redTaskId: string;        // RED task with existing locality
  let customerTaskId: string;
  let fibraTaskId: string;      // FIBRA task with existing locality

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
    await repo.createTask({ ...BASE_TASK, category: 'installation', kind: 'customer', customerId: 'c-dummy', contractId: 'ct-dummy', networkSiteId: null } as never);

    // RED network task gets id '8' — with existing locality (Mercedes).
    const redTask = await repo.createTask({ ...BASE_TASK, category: 'maintenance', kind: 'network', networkType: 'red', networkSiteId: '1', customerId: null, contractId: null } as never);
    redTaskId = redTask.id;

    // Customer task gets id '9'.
    const customerTask = await repo.createTask({ ...BASE_TASK, category: 'installation', kind: 'customer', customerId: 'c-1', contractId: 'ct-1', networkSiteId: null, iclassCityCode: null } as never);
    customerTaskId = customerTask.id;

    // FIBRA task — with existing locality (for guard testing).
    const fibraTask = repo.seedTask({ id: 'fibra-task-loc-guard', kind: 'network', networkType: 'fibra', networkSiteId: null, networkSiteName: 'Nodo FO', address: 'x', iclassCityCode: 'Mercedes' });
    fibraTaskId = fibraTask.id;
  });

  // RED: locality now optional — blanking it must NOT reject (#66 relaxation)
  it('REQ-LOC-UPDATE-RED-1: update RED task with iclassCityCode="" → ok (relaxed by #66)', async () => {
    const updated = await useCase.execute(redTaskId, { iclassCityCode: '' } as never);
    expect(updated).not.toBeNull();
  });

  it('REQ-LOC-UPDATE-RED-2: update RED task with iclassCityCode=null → ok (relaxed by #66)', async () => {
    const updated = await useCase.execute(redTaskId, { iclassCityCode: null } as never);
    expect(updated).not.toBeNull();
  });

  it('update network task NOT sending iclassCityCode (undefined) → ok (partial update)', async () => {
    const updated = await useCase.execute(redTaskId, { title: 'renamed' } as never);
    expect(updated?.title).toBe('renamed');
  });

  it('update customer task with iclassCityCode="" → ok (guard only applies to network)', async () => {
    const updated = await useCase.execute(customerTaskId, { iclassCityCode: '' } as never);
    expect(updated).not.toBeNull();
  });

  it('REQ-LOC-UPDATE-4: legacy network task (iclassCityCode null) + PUT echoing it blank + other fields → ok', async () => {
    const legacy = repo.seedTask({ id: 'legacy-net-loc-1', kind: 'network', networkSiteId: '1', address: 'x', iclassCityCode: null });
    const updated = await useCase.execute(legacy.id, { iclassCityCode: null, title: 'edited legacy' } as never);
    expect(updated).not.toBeNull();
    expect(updated?.title).toBe('edited legacy');
  });

  // FIBRA: locality still required — blanking it must reject
  it('REQ-LOC-UPDATE-5-FIBRA: fibra task WITH locality + PUT blanking it → 422', async () => {
    await expect(
      useCase.execute(fibraTaskId, { iclassCityCode: '' } as never),
    ).rejects.toBeInstanceOf(NetworkTaskLocalityRequiredError);
  });

  it('FIBRA task WITH locality + PUT setting null → 422', async () => {
    const fibraWithLoc = repo.seedTask({ id: 'fibra-loc-null-test', kind: 'network', networkType: 'fibra', networkSiteId: null, networkSiteName: 'Nodo FO-2', address: 'x', iclassCityCode: 'Rosario' });
    await expect(
      useCase.execute(fibraWithLoc.id, { iclassCityCode: null } as never),
    ).rejects.toBeInstanceOf(NetworkTaskLocalityRequiredError);
  });
});
