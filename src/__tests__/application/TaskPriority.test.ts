import { InMemoryTaskPriorityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskPriorityRepository';
import { ListTaskPriority } from '@application/use-cases/ListTaskPriority';
import { GetTaskPriority } from '@application/use-cases/GetTaskPriority';
import { CreateTaskPriority } from '@application/use-cases/CreateTaskPriority';
import { UpdateTaskPriority } from '@application/use-cases/UpdateTaskPriority';
import { DeleteTaskPriority } from '@application/use-cases/DeleteTaskPriority';
import {
  TaskPriorityNotFoundError,
  TaskPriorityNameConflictError,
  TaskPriorityInUseError,
} from '@domain/errors/scheduling';

describe('TaskPriority use cases', () => {
  let repo: InMemoryTaskPriorityRepository;
  let list: ListTaskPriority;
  let get: GetTaskPriority;
  let create: CreateTaskPriority;
  let update: UpdateTaskPriority;
  let del: DeleteTaskPriority;

  beforeEach(() => {
    repo = new InMemoryTaskPriorityRepository();
    list = new ListTaskPriority(repo);
    get = new GetTaskPriority(repo);
    create = new CreateTaskPriority(repo);
    update = new UpdateTaskPriority(repo);
    del = new DeleteTaskPriority(repo);
  });

  it('creates with color + weight and lists ordered by weight', async () => {
    await create.execute({ name: 'Alta', color: '#f59e0b', weight: 3 });
    await create.execute({ name: 'Baja', color: '#94a3b8', weight: 1 });
    const all = await list.execute();
    expect(all.map(p => p.name)).toEqual(['Baja', 'Alta']); // sorted by weight asc
    expect(all[1].color).toBe('#f59e0b');
  });

  it('rejects duplicate name (case-insensitive)', async () => {
    await create.execute({ name: 'Normal', color: '#3b82f6', weight: 2 });
    await expect(create.execute({ name: 'normal', color: '#000', weight: 9 })).rejects.toBeInstanceOf(TaskPriorityNameConflictError);
  });

  it('throws when getting unknown id', async () => {
    await expect(get.execute('nope')).rejects.toBeInstanceOf(TaskPriorityNotFoundError);
  });

  it('updates color and weight', async () => {
    const p = await create.execute({ name: 'Urgente', color: '#ef4444', weight: 4 });
    const updated = await update.execute(p.id, { color: '#dc2626', weight: 5 });
    expect(updated.color).toBe('#dc2626');
    expect(updated.weight).toBe(5);
  });

  it('update rejects a name colliding with another priority', async () => {
    await create.execute({ name: 'Baja', color: '#94a3b8', weight: 1 });
    const b = await create.execute({ name: 'Alta', color: '#f59e0b', weight: 3 });
    await expect(update.execute(b.id, { name: 'Baja' })).rejects.toBeInstanceOf(TaskPriorityNameConflictError);
  });

  it('refuses to delete a priority in use by tasks', async () => {
    const p = await create.execute({ name: 'Normal', color: '#3b82f6', weight: 2 });
    repo.taskCounts['Normal'] = 2;
    await expect(del.execute(p.id)).rejects.toBeInstanceOf(TaskPriorityInUseError);
  });

  it('deletes an unused priority', async () => {
    const p = await create.execute({ name: 'Temporal', color: '#000', weight: 9 });
    await del.execute(p.id);
    expect(await list.execute()).toHaveLength(0);
  });
});
