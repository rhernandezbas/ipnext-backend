import { InMemoryProjectRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { GetProject } from '../../../application/use-cases/GetProject';

describe('GetProject use case', () => {
  it('returns project when ID exists', async () => {
    const repo = new InMemoryProjectRepository();
    const created = await repo.create({ title: 'Existing' });
    const useCase = new GetProject(repo);
    const result = await useCase.execute(created.id);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Existing');
  });

  it('returns null when ID does not exist', async () => {
    const repo = new InMemoryProjectRepository();
    const useCase = new GetProject(repo);
    const result = await useCase.execute('nonexistent-id');
    expect(result).toBeNull();
  });
});
