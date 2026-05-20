import { AddChecklistItem } from '../../../application/use-cases/AddChecklistItem';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';

describe('AddChecklistItem', () => {
  let repo: InMemorySchedulingRepository;
  let useCase: AddChecklistItem;
  const TASK_ID = '1'; // seeded task

  beforeEach(() => {
    repo = new InMemorySchedulingRepository();
    useCase = new AddChecklistItem(repo);
  });

  it('appends item with order 0 when checklist is empty', async () => {
    const item = await useCase.execute(TASK_ID, 'Do something');
    expect(item).not.toBeNull();
    expect(item!.order).toBe(0);
    expect(item!.text).toBe('Do something');
    expect(item!.done).toBe(false);
    expect(item!.taskId).toBe(TASK_ID);
    expect(item!.fromTemplateItemId).toBeNull();
  });

  it('appends item with order = max + 1', async () => {
    await useCase.execute(TASK_ID, 'First');
    await useCase.execute(TASK_ID, 'Second');
    const third = await useCase.execute(TASK_ID, 'Third');
    expect(third!.order).toBe(2);
  });

  it('returns null for unknown taskId', async () => {
    const result = await useCase.execute('nonexistent', 'Text');
    expect(result).toBeNull();
  });
});
