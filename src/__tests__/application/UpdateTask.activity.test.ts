import { UpdateTask } from '@application/use-cases/UpdateTask';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id }; }
}

function makeUseCase(repo: InMemorySchedulingRepository, recorder?: FakeTaskActivityRecorder) {
  const any = new AnyLookup();
  return new UpdateTask(repo, any, any, any, any, any, recorder);
}

describe('UpdateTask activity (D.2 integration)', () => {
  it('emits the diff events via recordMany with the actor', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', priority: 'low', notes: null });
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(repo, recorder);

    await uc.execute('task-1', { priority: 'high', notes: 'check' }, ACTOR);

    expect(recorder.manyCalls).toHaveLength(1);
    expect(recorder.manyCalls[0].taskId).toBe('task-1');
    const events = recorder.manyCalls[0].events;
    expect(events).toContainEqual({ type: 'priority_changed', actor: ACTOR, fromValue: 'low', toValue: 'high' });
    expect(events).toContainEqual({ type: 'notes_changed', actor: ACTOR, fromValue: null, toValue: 'check' });
  });

  it('does not call recordMany when nothing actually changed', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', priority: 'low' });
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(repo, recorder);

    await uc.execute('task-1', { priority: 'low' }, ACTOR);

    expect(recorder.manyCalls).toHaveLength(0);
  });

  it('emits nothing and returns null for a missing task', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const uc = makeUseCase(repo, recorder);

    const result = await uc.execute('ghost', { priority: 'high' }, ACTOR);

    expect(result).toBeNull();
    expect(recorder.manyCalls).toHaveLength(0);
  });

  it('still updates the task when no recorder is wired (backwards-compat)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', priority: 'low' });
    const uc = makeUseCase(repo, undefined);

    const updated = await uc.execute('task-1', { priority: 'high' }, ACTOR);

    expect(updated?.priority).toBe('high');
  });
});
