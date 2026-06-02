import { InMemoryWorkflowRepository } from '../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { ListWorkflows } from '../../application/use-cases/ListWorkflows';

describe('ListWorkflows', () => {
  it('returns empty array when no workflows', async () => {
    const repo = new InMemoryWorkflowRepository();
    const uc = new ListWorkflows(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(0);
  });

  it('returns workflows with stages sorted by order ascending', async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.create({
      name: 'Test WF',
      description: null,
      stages: [
        { name: 'Hecho', code: 'hecho', category: 'hecho', order: 2 },
        { name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0 },
        { name: 'En progreso', code: 'en_progreso', category: 'enProgreso', order: 1 },
      ],
    });
    const uc = new ListWorkflows(repo);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].stages.map(s => s.order)).toEqual([0, 1, 2]);
  });
});
