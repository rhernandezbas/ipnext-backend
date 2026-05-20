import { InMemoryProjectRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { DeleteProject } from '../../../application/use-cases/DeleteProject';

describe('DeleteProject use case', () => {
  it('returns true when project exists and is deleted', async () => {
    const repo = new InMemoryProjectRepository();
    const project = await repo.create({ title: 'To delete' });
    const uc = new DeleteProject(repo);
    const result = await uc.execute(project.id);
    expect(result).toBe(true);
    // Verify it's gone
    const found = await repo.get(project.id);
    expect(found).toBeNull();
  });

  it('returns false when project does not exist', async () => {
    const repo = new InMemoryProjectRepository();
    const uc = new DeleteProject(repo);
    const result = await uc.execute('nonexistent-id');
    expect(result).toBe(false);
  });
});
