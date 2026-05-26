import { InMemoryTaskCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCategoryRepository';
import { ListTaskCategory } from '@application/use-cases/ListTaskCategory';
import { GetTaskCategory } from '@application/use-cases/GetTaskCategory';
import { CreateTaskCategory } from '@application/use-cases/CreateTaskCategory';
import { UpdateTaskCategory } from '@application/use-cases/UpdateTaskCategory';
import { DeleteTaskCategory } from '@application/use-cases/DeleteTaskCategory';
import {
  TaskCategoryNotFoundError,
  TaskCategoryNameConflictError,
  TaskCategoryInUseError,
} from '@domain/errors/scheduling';

describe('TaskCategory use cases', () => {
  let repo: InMemoryTaskCategoryRepository;
  let list: ListTaskCategory;
  let get: GetTaskCategory;
  let create: CreateTaskCategory;
  let update: UpdateTaskCategory;
  let del: DeleteTaskCategory;

  beforeEach(() => {
    repo = new InMemoryTaskCategoryRepository();
    list = new ListTaskCategory(repo);
    get = new GetTaskCategory(repo);
    create = new CreateTaskCategory(repo);
    update = new UpdateTaskCategory(repo);
    del = new DeleteTaskCategory(repo);
  });

  it('lists empty initially', async () => {
    expect(await list.execute()).toEqual([]);
  });

  it('creates and retrieves a category', async () => {
    const created = await create.execute({ name: 'Instalación' });
    const got = await get.execute(created.id);
    expect(got.name).toBe('Instalación');
    expect((await list.execute())).toHaveLength(1);
  });

  it('rejects duplicate name (case-insensitive)', async () => {
    await create.execute({ name: 'Instalación' });
    await expect(create.execute({ name: 'instalación' })).rejects.toBeInstanceOf(TaskCategoryNameConflictError);
  });

  it('throws when getting an unknown id', async () => {
    await expect(get.execute('nope')).rejects.toBeInstanceOf(TaskCategoryNotFoundError);
  });

  it('updates the name', async () => {
    const created = await create.execute({ name: 'Reparación' });
    const updated = await update.execute(created.id, { name: 'Reparación urgente' });
    expect(updated.name).toBe('Reparación urgente');
  });

  it('update rejects a name that collides with another category', async () => {
    await create.execute({ name: 'Instalación' });
    const b = await create.execute({ name: 'Reparación' });
    await expect(update.execute(b.id, { name: 'Instalación' })).rejects.toBeInstanceOf(TaskCategoryNameConflictError);
  });

  it('deletes a category', async () => {
    const created = await create.execute({ name: 'Otro' });
    await del.execute(created.id);
    expect(await list.execute()).toHaveLength(0);
  });

  it('refuses to delete a category in use by tasks', async () => {
    const created = await create.execute({ name: 'Mantenimiento' });
    repo.taskCounts['Mantenimiento'] = 3;
    await expect(del.execute(created.id)).rejects.toBeInstanceOf(TaskCategoryInUseError);
  });
});
