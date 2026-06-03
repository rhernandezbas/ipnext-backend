import { InMemoryTaskActivityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskActivityRepository';
import type { CreateTaskActivityInput } from '@domain/ports/TaskActivityRepository';

function makeInput(over: Partial<CreateTaskActivityInput> = {}): CreateTaskActivityInput {
  return {
    taskId: over.taskId ?? 'task-1',
    type: over.type ?? 'created',
    actorId: over.actorId ?? 'user-1',
    actorName: over.actorName ?? 'Alice',
    fromValue: over.fromValue,
    toValue: over.toValue,
    metadata: over.metadata ?? null,
  };
}

describe('InMemoryTaskActivityRepository', () => {
  it('create returns a stored entity with id + ISO createdAt', async () => {
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date('2026-06-03T10:00:00Z') });

    const a = await repo.create(makeInput({ type: 'created', toValue: { title: 'X' } }));

    expect(a.id).toBeTruthy();
    expect(a.taskId).toBe('task-1');
    expect(a.type).toBe('created');
    expect(a.actorId).toBe('user-1');
    expect(a.actorName).toBe('Alice');
    expect(a.createdAt).toBe('2026-06-03T10:00:00.000Z');
    expect(a.toValue).toEqual({ title: 'X' });
    expect(a.metadata).toBeNull();
  });

  it('listByTask returns newest-first (createdAt DESC)', async () => {
    let t = Date.parse('2026-06-03T10:00:00Z');
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date(t) });
    await repo.create(makeInput({ type: 'created' })); t += 1000;
    await repo.create(makeInput({ type: 'priority_changed' })); t += 1000;
    await repo.create(makeInput({ type: 'commented' }));

    const list = await repo.listByTask({ taskId: 'task-1', limit: 10 });

    expect(list.map(a => a.type)).toEqual(['commented', 'priority_changed', 'created']);
  });

  it('listByTask respects the limit', async () => {
    let t = Date.parse('2026-06-03T10:00:00Z');
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date(t) });
    for (let i = 0; i < 5; i++) { await repo.create(makeInput()); t += 1000; }

    const list = await repo.listByTask({ taskId: 'task-1', limit: 2 });

    expect(list).toHaveLength(2);
  });

  it('cursor returns only rows STRICTLY older than the cursor', async () => {
    let t = Date.parse('2026-06-03T10:00:00Z');
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date(t) });
    const a1 = await repo.create(makeInput({ type: 'created' })); t += 1000;
    const a2 = await repo.create(makeInput({ type: 'priority_changed' })); t += 1000;
    const a3 = await repo.create(makeInput({ type: 'commented' }));

    // newest-first is [a3, a2, a1]; a cursor at a3 must exclude a3 and return [a2, a1].
    const page = await repo.listByTask({
      taskId: 'task-1',
      limit: 10,
      cursor: { createdAt: a3.createdAt, id: a3.id },
    });

    expect(page.map(a => a.id)).toEqual([a2.id, a1.id]);
  });

  it('createMany inserts all entries and returns the count', async () => {
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date('2026-06-03T10:00:00Z') });

    const n = await repo.createMany([
      makeInput({ type: 'watcher_added' }),
      makeInput({ type: 'watcher_removed' }),
    ]);

    expect(n).toBe(2);
    const list = await repo.listByTask({ taskId: 'task-1', limit: 10 });
    expect(list).toHaveLength(2);
  });

  it('listByTask is scoped to a single task', async () => {
    const repo = new InMemoryTaskActivityRepository({ now: () => new Date('2026-06-03T10:00:00Z') });
    await repo.create(makeInput({ taskId: 'task-1' }));
    await repo.create(makeInput({ taskId: 'task-2' }));

    const list = await repo.listByTask({ taskId: 'task-1', limit: 10 });

    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe('task-1');
  });
});
