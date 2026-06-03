import {
  GetTaskActivity,
  encodeCursor,
  decodeCursor,
  clampLimit,
} from '@application/use-cases/GetTaskActivity';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryTaskActivityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskActivityRepository';
import { TaskNotFoundError, InvalidCursorError } from '@domain/errors/scheduling';
import type { CreateTaskActivityInput } from '@domain/ports/TaskActivityRepository';

function activityInput(over: Partial<CreateTaskActivityInput> = {}): CreateTaskActivityInput {
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

function makeHarness() {
  let clock = Date.parse('2026-06-03T10:00:00Z');
  const scheduling = new InMemorySchedulingRepository();
  const activities = new InMemoryTaskActivityRepository({ now: () => new Date(clock) });
  const useCase = new GetTaskActivity(scheduling, activities);
  return {
    scheduling,
    activities,
    useCase,
    tick: () => { clock += 1000; },
    setClock: (v: number) => { clock = v; },
  };
}

describe('cursor codec (B.3)', () => {
  it('round-trips an encode → decode', () => {
    const cur = { createdAt: '2026-06-03T10:00:00.000Z', id: 'act-9' };
    const decoded = decodeCursor(encodeCursor(cur));
    expect(decoded).toEqual(cur);
  });

  it('throws InvalidCursorError on non-base64 / wrong shape / bad date', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('no-pipe-here').toString('base64url'))).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('not-a-date|act-1').toString('base64url'))).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('2026-06-03T10:00:00.000Z|').toString('base64url'))).toThrow(InvalidCursorError);
  });
});

describe('clampLimit (B.1)', () => {
  it('defaults to 50, floors at 1, caps at 200', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-7)).toBe(1);
    expect(clampLimit(25)).toBe(25);
    expect(clampLimit(200)).toBe(200);
    expect(clampLimit(999)).toBe(200);
  });
});

describe('GetTaskActivity (B.1/B.2)', () => {
  it('throws TaskNotFoundError when the task does not exist', async () => {
    const h = makeHarness();
    await expect(h.useCase.execute('ghost', {})).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('returns the feed newest-first with nextCursor null when it fits in one page', async () => {
    const h = makeHarness();
    h.scheduling.seedTask({ id: 'task-1' });
    await h.activities.create(activityInput({ type: 'created' })); h.tick();
    await h.activities.create(activityInput({ type: 'priority_changed' }));

    const result = await h.useCase.execute('task-1', {});

    expect(result.items.map(a => a.type)).toEqual(['priority_changed', 'created']);
    expect(result.nextCursor).toBeNull();
  });

  it('paginates with a cursor across pages', async () => {
    const h = makeHarness();
    h.scheduling.seedTask({ id: 'task-1' });
    await h.activities.create(activityInput({ type: 'created' })); h.tick();
    await h.activities.create(activityInput({ type: 'priority_changed' })); h.tick();
    await h.activities.create(activityInput({ type: 'commented' }));

    const page1 = await h.useCase.execute('task-1', { limit: 2 });
    expect(page1.items.map(a => a.type)).toEqual(['commented', 'priority_changed']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await h.useCase.execute('task-1', { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map(a => a.type)).toEqual(['created']);
    expect(page2.nextCursor).toBeNull();
  });

  it('throws InvalidCursorError when the cursor is malformed', async () => {
    const h = makeHarness();
    h.scheduling.seedTask({ id: 'task-1' });
    await expect(h.useCase.execute('task-1', { cursor: 'garbage' })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
