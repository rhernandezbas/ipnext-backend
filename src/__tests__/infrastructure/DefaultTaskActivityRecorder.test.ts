import { DefaultTaskActivityRecorder } from '@infrastructure/services/DefaultTaskActivityRecorder';
import { RecordTaskActivity } from '@application/use-cases/RecordTaskActivity';
import { InMemoryTaskActivityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskActivityRepository';
import type { TaskActivityRepository } from '@domain/ports/TaskActivityRepository';

const throwingRepo: TaskActivityRepository = {
  create: async () => { throw new Error('db down'); },
  createMany: async () => { throw new Error('db down'); },
  listByTask: async () => [],
};

describe('DefaultTaskActivityRecorder (C.3)', () => {
  it('record() persists via the use case with the actor unwrapped', async () => {
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date('2026-06-03T10:00:00Z') });
    const recorder = new DefaultTaskActivityRecorder(new RecordTaskActivity(repo));

    await recorder.record('task-1', 'created', {
      actor: { actorId: 'u1', actorName: 'Alice' },
      toValue: { title: 'X' },
    });

    const list = await repo.listByTask({ taskId: 'task-1', limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0].actorId).toBe('u1');
    expect(list[0].actorName).toBe('Alice');
    expect(list[0].type).toBe('created');
    expect(list[0].toValue).toEqual({ title: 'X' });
  });

  it('swallows errors and never throws — best-effort (REQ-RESILIENCE-1)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = new DefaultTaskActivityRecorder(new RecordTaskActivity(throwingRepo));

    await expect(
      recorder.record('task-1', 'created', { actor: { actorId: null, actorName: 'System' } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // REQ-RESILIENCE-1: the warning must carry the taskId AND the activity type.
    const logged = warn.mock.calls[0].join(' ');
    expect(logged).toContain('task-1');
    expect(logged).toContain('created');

    warn.mockRestore();
  });

  it('recordMany() batches events for a single task', async () => {
    const repo = new InMemoryTaskActivityRepository();
    const recorder = new DefaultTaskActivityRecorder(new RecordTaskActivity(repo));

    await recorder.recordMany('task-1', [
      { type: 'watcher_added', actor: { actorId: 'u', actorName: 'A' } },
      { type: 'watcher_removed', actor: { actorId: 'u', actorName: 'A' } },
    ]);

    expect(await repo.listByTask({ taskId: 'task-1', limit: 10 })).toHaveLength(2);
  });

  it('recordMany() also swallows errors and never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = new DefaultTaskActivityRecorder(new RecordTaskActivity(throwingRepo));

    await expect(
      recorder.recordMany('task-1', [{ type: 'created', actor: { actorId: null, actorName: 'S' } }]),
    ).resolves.toBeUndefined();

    warn.mockRestore();
  });
});
