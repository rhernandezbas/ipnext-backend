/**
 * Unit tests for PrismaTaskActivityRepository.toTaskActivity — the pure row→entity
 * mapper. Mirrors the project convention of testing the Prisma mapper in isolation
 * (see PrismaSchedulingRepository.toTask) without a live database.
 */
import { toTaskActivity } from '@infrastructure/adapters/prisma/PrismaTaskActivityRepository';

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    taskId: 'task-1',
    type: 'created',
    actorId: 'user-1',
    actorName: 'Alice',
    fromValue: null,
    toValue: { title: 'X' },
    metadata: null,
    createdAt: new Date('2026-06-03T10:00:00Z'),
    ...over,
  };
}

describe('PrismaTaskActivityRepository.toTaskActivity', () => {
  it('maps a row to the TaskActivity entity with an ISO createdAt', () => {
    const a = toTaskActivity(makeRow());

    expect(a).toEqual({
      id: 'act-1',
      taskId: 'task-1',
      type: 'created',
      actorId: 'user-1',
      actorName: 'Alice',
      fromValue: null,
      toValue: { title: 'X' },
      metadata: null,
      createdAt: '2026-06-03T10:00:00.000Z',
    });
  });

  it('maps a null actor (system/automatic action)', () => {
    const a = toTaskActivity(makeRow({ actorId: null }));
    expect(a.actorId).toBeNull();
    expect(a.actorName).toBe('Alice');
  });

  it('preserves JSON from/to/metadata values', () => {
    const a = toTaskActivity(
      makeRow({ fromValue: { p: 'low' }, toValue: { p: 'high' }, metadata: { field: 'priority' } }),
    );
    expect(a.fromValue).toEqual({ p: 'low' });
    expect(a.toValue).toEqual({ p: 'high' });
    expect(a.metadata).toEqual({ field: 'priority' });
  });
});
