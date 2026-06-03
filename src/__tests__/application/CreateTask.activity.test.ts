import { CreateTask } from '@application/use-cases/CreateTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';
const CUSTOMER_ID = 'customer-default-0000-000000000001';
const CONTRACT_ID = 'contract-default-00000-000000000001';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id }; }
}

function makeBase() {
  return {
    title: 'Test task',
    description: null,
    stageId: DEFAULT_STAGE_ID,
    priority: 'normal' as const,
    estimatedHours: 1,
    address: null,
    coordinates: null,
    category: 'installation' as const,
    projectId: null,
    projectName: null,
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    customerId: CUSTOMER_ID,
    contractId: CONTRACT_ID,
    partnerId: null,
    reporterId: null,
    assigneeId: null,
    watcherIds: [],
    travelTimeTo: null,
    travelTimeFrom: null,
  };
}

function makeUseCase(recorder?: FakeTaskActivityRecorder) {
  const repo = new InMemorySchedulingRepository();
  const any = new AnyLookup();
  return new CreateTask(repo, any, any, any, any, any, undefined, recorder);
}

describe('CreateTask activity (D.1)', () => {
  it('emits a `created` event with the actor and a task snapshot', async () => {
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(recorder);

    const task = await uc.execute(makeBase(), { actorId: 'u1', actorName: 'Alice' });

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call.taskId).toBe(task.id);
    expect(call.type).toBe('created');
    expect(call.payload.actor).toEqual({ actorId: 'u1', actorName: 'Alice' });
    // Snapshot must match the spec shape: title, stageId, priority, category, assigneeId, watcherIds.
    expect(call.payload.toValue).toEqual({
      title: 'Test task',
      stageId: task.stageId,
      priority: 'normal',
      category: 'installation',
      assigneeId: null,
      watcherIds: [],
    });
  });

  it('falls back to the System actor when none is passed', async () => {
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(recorder);

    await uc.execute(makeBase());

    expect(recorder.calls[0].payload.actor).toEqual({ actorId: null, actorName: 'System' });
  });

  it('still creates the task when no recorder is wired (backwards-compat)', async () => {
    const uc = makeUseCase(undefined);
    const task = await uc.execute(makeBase(), { actorId: 'u1', actorName: 'Alice' });
    expect(task.id).toBeTruthy();
  });
});
