import { InMemoryProjectRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { DeleteProject } from '../../../application/use-cases/DeleteProject';
import { ProjectHasActiveTasksError } from '../../../domain/errors/projects';

describe('DeleteProject use case (soft delete + active-task guard)', () => {
  it('soft-deletes (sets visible=false) when project has no active tasks', async () => {
    const repo = new InMemoryProjectRepository();
    const project = await repo.create({ title: 'To disable' });
    const uc = new DeleteProject(repo);

    const result = await uc.execute(project.id);

    expect(result).toBe(true);
    const found = await repo.get(project.id);
    expect(found).not.toBeNull();
    expect(found!.visible).toBe(false);
  });

  it('soft-deletes when project has only "hecho" tasks', async () => {
    const repo = new InMemoryProjectRepository();
    const project = await repo.create({ title: 'Done only' });
    repo.seedTaskCounts(project.id, { nuevo: 0, enProgreso: 0, hecho: 5, total: 5 });
    const uc = new DeleteProject(repo);

    const result = await uc.execute(project.id);

    expect(result).toBe(true);
    const found = await repo.get(project.id);
    expect(found!.visible).toBe(false);
  });

  it('throws ProjectHasActiveTasksError when project has tasks in "nuevo"', async () => {
    const repo = new InMemoryProjectRepository();
    const project = await repo.create({ title: 'Has new tasks' });
    repo.seedTaskCounts(project.id, { nuevo: 2, enProgreso: 0, hecho: 1, total: 3 });
    const uc = new DeleteProject(repo);

    await expect(uc.execute(project.id)).rejects.toThrow(ProjectHasActiveTasksError);

    // Still visible — not soft-deleted
    const found = await repo.get(project.id);
    expect(found!.visible).toBe(true);
  });

  it('throws ProjectHasActiveTasksError when project has tasks in "enProgreso"', async () => {
    const repo = new InMemoryProjectRepository();
    const project = await repo.create({ title: 'Has in-progress' });
    repo.seedTaskCounts(project.id, { nuevo: 0, enProgreso: 4, hecho: 0, total: 4 });
    const uc = new DeleteProject(repo);

    await expect(uc.execute(project.id)).rejects.toThrow(ProjectHasActiveTasksError);

    const found = await repo.get(project.id);
    expect(found!.visible).toBe(true);
  });

  it('returns false when project does not exist', async () => {
    const repo = new InMemoryProjectRepository();
    const uc = new DeleteProject(repo);
    const result = await uc.execute('nonexistent-id');
    expect(result).toBe(false);
  });
});
