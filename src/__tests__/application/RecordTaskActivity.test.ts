import { RecordTaskActivity } from '@application/use-cases/RecordTaskActivity';
import { InMemoryTaskActivityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskActivityRepository';

describe('RecordTaskActivity (C.1)', () => {
  it('persists a single activity with the given shape', async () => {
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date('2026-06-03T10:00:00Z') });
    const uc = new RecordTaskActivity(repo);

    const a = await uc.execute({
      taskId: 'task-1',
      type: 'priority_changed',
      actorId: 'u1',
      actorName: 'Alice',
      fromValue: { p: 'low' },
      toValue: { p: 'high' },
      metadata: { field: 'priority' },
    });

    expect(a.taskId).toBe('task-1');
    expect(a.type).toBe('priority_changed');
    expect(a.actorId).toBe('u1');
    expect(a.fromValue).toEqual({ p: 'low' });
    expect(a.toValue).toEqual({ p: 'high' });
    expect(a.metadata).toEqual({ field: 'priority' });
    expect(await repo.listByTask({ taskId: 'task-1', limit: 10 })).toHaveLength(1);
  });

  it('executeMany persists a batch and returns the count', async () => {
    const repo = new InMemoryTaskActivityRepository();
    const uc = new RecordTaskActivity(repo);

    const n = await uc.executeMany([
      { taskId: 'task-1', type: 'watcher_added', actorId: 'u', actorName: 'A', metadata: null },
      { taskId: 'task-1', type: 'watcher_removed', actorId: 'u', actorName: 'A', metadata: null },
    ]);

    expect(n).toBe(2);
    expect(await repo.listByTask({ taskId: 'task-1', limit: 10 })).toHaveLength(2);
  });
});
