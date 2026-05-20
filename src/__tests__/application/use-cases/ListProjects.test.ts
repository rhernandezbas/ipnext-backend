import { InMemoryProjectRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { ListProjects } from '../../../application/use-cases/ListProjects';

function makeRepo() {
  return new InMemoryProjectRepository();
}

describe('ListProjects use case', () => {
  it('returns empty array when no projects exist', async () => {
    const repo = makeRepo();
    const useCase = new ListProjects(repo);
    const result = await useCase.execute();
    expect(result).toEqual([]);
  });

  it('returns all projects when no filter', async () => {
    const repo = makeRepo();
    await repo.create({ title: 'P1', visible: true });
    await repo.create({ title: 'P2', visible: false });
    const useCase = new ListProjects(repo);
    const result = await useCase.execute();
    expect(result).toHaveLength(2);
  });

  it('filters visible=true projects', async () => {
    const repo = makeRepo();
    await repo.create({ title: 'Visible', visible: true });
    await repo.create({ title: 'Hidden', visible: false });
    const useCase = new ListProjects(repo);
    const result = await useCase.execute({ visible: true });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Visible');
  });

  it('filters visible=false projects', async () => {
    const repo = makeRepo();
    await repo.create({ title: 'Visible', visible: true });
    await repo.create({ title: 'Hidden', visible: false });
    const useCase = new ListProjects(repo);
    const result = await useCase.execute({ visible: false });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Hidden');
  });

  it('returned projects have taskCounts shape', async () => {
    const repo = makeRepo();
    await repo.create({ title: 'P1' });
    const useCase = new ListProjects(repo);
    const result = await useCase.execute();
    expect(result[0].taskCounts).toEqual({ nuevo: 0, enProgreso: 0, hecho: 0, total: 0 });
  });
});
