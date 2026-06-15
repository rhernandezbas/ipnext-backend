/**
 * STRICT TDD — scenarios C1-C5 from the design matrix.
 * Tests written BEFORE the UpdateTask collaborator extension.
 */
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { IClassAutoAssigner, AutoAssignOutcome } from '@domain/ports/IClassAutoAssigner';

const TASK_ID = 'task-autoassign-ut';
const OLD_ASSIGNEE = 'user-old';
const NEW_ASSIGNEE = 'user-new';

// Spy IClassAutoAssigner
class SpyAutoAssigner implements IClassAutoAssigner {
  calls: Array<{ taskId: string; assigneeId: string | null }> = [];
  shouldThrow = false;
  outcome: AutoAssignOutcome = { outcome: 'assigned', teamLogin: 'equipe-01' };

  async maybeAssign(taskId: string, assigneeId: string | null): Promise<AutoAssignOutcome> {
    if (this.shouldThrow) throw new Error('Spy explosion — UpdateTask must NOT propagate this');
    this.calls.push({ taskId, assigneeId });
    return this.outcome;
  }
}

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

async function makeContext() {
  const stageRepo = new InMemoryStageRepository();
  const schedulingRepo = new InMemorySchedulingRepository(stageRepo);
  const anyLookup = new AnyLookup();
  const spy = new SpyAutoAssigner();

  // Seed task with OLD_ASSIGNEE
  schedulingRepo.seedTask({ id: TASK_ID, title: 'Task', generalStatus: 'open', assigneeId: OLD_ASSIGNEE });

  return { schedulingRepo, spy, anyLookup };
}

function makeUpdateTask(schedulingRepo: InMemorySchedulingRepository, anyLookup: AnyLookup, spy?: IClassAutoAssigner) {
  return new UpdateTask(
    schedulingRepo,
    anyLookup,
    anyLookup,
    anyLookup,
    anyLookup,
    anyLookup,
    undefined, // no recorder
    spy,       // optional IClassAutoAssigner
  );
}

describe('UpdateTask — IClassAutoAssigner collaborator (C1-C5)', () => {
  // C1: assigneeId CHANGED → maybeAssign invoked once
  it('C1: assigneeId changed → maybeAssign called once with new assignee', async () => {
    const { schedulingRepo, spy, anyLookup } = await makeContext();
    const uc = makeUpdateTask(schedulingRepo, anyLookup, spy);

    await uc.execute(TASK_ID, { assigneeId: NEW_ASSIGNEE });

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.taskId).toBe(TASK_ID);
    expect(spy.calls[0]!.assigneeId).toBe(NEW_ASSIGNEE);
  });

  // C2: assigneeId SAME as current → maybeAssign NOT invoked
  it('C2: assigneeId unchanged → maybeAssign NOT called', async () => {
    const { schedulingRepo, spy, anyLookup } = await makeContext();
    const uc = makeUpdateTask(schedulingRepo, anyLookup, spy);

    await uc.execute(TASK_ID, { assigneeId: OLD_ASSIGNEE }); // same as seeded

    expect(spy.calls).toHaveLength(0);
  });

  // C3: assigneeId not in body → maybeAssign NOT invoked
  it('C3: assigneeId not in body → maybeAssign NOT called', async () => {
    const { schedulingRepo, spy, anyLookup } = await makeContext();
    const uc = makeUpdateTask(schedulingRepo, anyLookup, spy);

    await uc.execute(TASK_ID, { title: 'New title' });

    expect(spy.calls).toHaveLength(0);
  });

  // C4: maybeAssign throws → UpdateTask still persists, does NOT propagate
  it('C4: maybeAssign throws → UpdateTask persists and does NOT fail', async () => {
    const { schedulingRepo, spy, anyLookup } = await makeContext();
    spy.shouldThrow = true;
    const uc = makeUpdateTask(schedulingRepo, anyLookup, spy);

    // Must NOT throw
    const result = await uc.execute(TASK_ID, { assigneeId: NEW_ASSIGNEE, title: 'Updated' });

    // The task was still updated
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Updated');
    expect(result!.assigneeId).toBe(NEW_ASSIGNEE);
  });

  // C5: no assigner injected → behavior identical to current (no crash)
  it('C5: no assigner injected → executes normally without any assigner interaction', async () => {
    const { schedulingRepo, anyLookup } = await makeContext();
    const uc = makeUpdateTask(schedulingRepo, anyLookup, undefined); // no assigner

    const result = await uc.execute(TASK_ID, { assigneeId: NEW_ASSIGNEE, title: 'No assigner' });

    expect(result).not.toBeNull();
    expect(result!.assigneeId).toBe(NEW_ASSIGNEE);
  });
});
