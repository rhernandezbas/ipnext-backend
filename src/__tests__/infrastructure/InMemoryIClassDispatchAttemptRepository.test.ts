import { InMemoryIClassDispatchAttemptRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository';

describe('InMemoryIClassDispatchAttemptRepository', () => {
  it('record() persists the attempt and returns it with id and createdAt', async () => {
    const repo = new InMemoryIClassDispatchAttemptRepository();
    const result = await repo.record({
      taskId: 'task-1',
      outcome: 'node_not_found',
      errorCode: 'ICLASS_NODE_NOT_FOUND',
      errorMessage: 'Node not found',
      attemptedNodeCode: null,
      resolvedNodeCode: null,
      actorId: 'user-1',
    });

    expect(result.id).toBeDefined();
    expect(result.taskId).toBe('task-1');
    expect(result.outcome).toBe('node_not_found');
    expect(result.errorCode).toBe('ICLASS_NODE_NOT_FOUND');
    expect(result.errorMessage).toBe('Node not found');
    expect(result.attemptedNodeCode).toBeNull();
    expect(result.resolvedNodeCode).toBeNull();
    expect(result.actorId).toBe('user-1');
    expect(typeof result.createdAt).toBe('string');
  });

  it('listByTask() returns the attempt for the matching taskId', async () => {
    const repo = new InMemoryIClassDispatchAttemptRepository();
    await repo.record({ taskId: 'task-1', outcome: 'node_not_found' });

    const list = await repo.listByTask('task-1');
    expect(list).toHaveLength(1);
    expect(list[0]!.taskId).toBe('task-1');
    expect(list[0]!.outcome).toBe('node_not_found');
  });

  it('listByTask() returns empty array for a different taskId', async () => {
    const repo = new InMemoryIClassDispatchAttemptRepository();
    await repo.record({ taskId: 'task-1', outcome: 'success' });

    const list = await repo.listByTask('task-other');
    expect(list).toHaveLength(0);
  });

  it('listByTask() returns attempts in ASC order by createdAt (oldest first)', async () => {
    const repo = new InMemoryIClassDispatchAttemptRepository();

    // Insert with controlled createdAt via seed helper
    repo.seed({ taskId: 'task-1', outcome: 'node_not_found', createdAt: '2026-06-01T10:00:00.000Z' });
    repo.seed({ taskId: 'task-1', outcome: 'rejected', createdAt: '2026-06-01T12:00:00.000Z' });
    repo.seed({ taskId: 'task-1', outcome: 'success', createdAt: '2026-06-01T11:00:00.000Z' });

    const list = await repo.listByTask('task-1');
    expect(list).toHaveLength(3);
    expect(list[0]!.outcome).toBe('node_not_found'); // t1 = 10:00
    expect(list[1]!.outcome).toBe('success');         // t2 = 11:00
    expect(list[2]!.outcome).toBe('rejected');        // t3 = 12:00
  });

  it('record() without errorCode leaves errorCode null', async () => {
    const repo = new InMemoryIClassDispatchAttemptRepository();
    const result = await repo.record({ taskId: 'task-1', outcome: 'success' });

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.attemptedNodeCode).toBeNull();
    expect(result.resolvedNodeCode).toBeNull();
    expect(result.actorId).toBeNull();
  });
});
