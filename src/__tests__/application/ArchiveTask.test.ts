/**
 * TDD — #86 ArchiveTask use case.
 *
 * (a) archivar tarea closed → archivedAt seteado
 * (b) archivar tarea open → throw TaskNotClosedError
 * (c) archivar tarea dismissed → OK
 * (d) idempotente (archivar 2x)
 * (e) not found → throw TaskNotFoundError
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ArchiveTask } from '../../application/use-cases/ArchiveTask';
import { TaskNotClosedError, TaskNotFoundError } from '../../domain/errors/scheduling';

const STAGE_ID = '10000000-0000-4000-a000-000000000001';

function makeRepo() {
  return new InMemorySchedulingRepository();
}

describe('ArchiveTask (#86)', () => {
  it('(a) archives a closed task — sets archivedAt', async () => {
    const repo = makeRepo();
    const task = repo.seedTask({ id: 'task-a', stageId: STAGE_ID, generalStatus: 'closed', isClosed: true, archivedAt: null });

    const uc = new ArchiveTask(repo);
    const result = await uc.execute('task-a');

    expect(result.id).toBe('task-a');
    expect(result.archivedAt).not.toBeNull();
    // Should be a valid ISO 8601 string
    expect(() => new Date(result.archivedAt!)).not.toThrow();
  });

  it('(b) throws TaskNotClosedError for an open task', async () => {
    const repo = makeRepo();
    repo.seedTask({ id: 'task-b', stageId: STAGE_ID, generalStatus: 'open', isClosed: false, archivedAt: null });

    const uc = new ArchiveTask(repo);
    await expect(uc.execute('task-b')).rejects.toBeInstanceOf(TaskNotClosedError);
  });

  it('(c) archives a dismissed task — sets archivedAt', async () => {
    const repo = makeRepo();
    repo.seedTask({ id: 'task-c', stageId: STAGE_ID, generalStatus: 'dismissed', isClosed: false, archivedAt: null });

    const uc = new ArchiveTask(repo);
    const result = await uc.execute('task-c');

    expect(result.id).toBe('task-c');
    expect(result.archivedAt).not.toBeNull();
  });

  it('(d) idempotent — archiving twice returns same task without resetting archivedAt', async () => {
    const repo = makeRepo();
    const fixedDate = '2026-07-14T10:00:00.000Z';
    repo.seedTask({ id: 'task-d', stageId: STAGE_ID, generalStatus: 'closed', isClosed: true, archivedAt: fixedDate });

    const uc = new ArchiveTask(repo);
    const result = await uc.execute('task-d');

    expect(result.archivedAt).toBe(fixedDate);
  });

  it('(e) throws TaskNotFoundError when task does not exist', async () => {
    const repo = makeRepo();

    const uc = new ArchiveTask(repo);
    await expect(uc.execute('nonexistent')).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
