import { ClearTaskChecklist } from '../../../application/use-cases/ClearTaskChecklist';
import { AddChecklistItem } from '../../../application/use-cases/AddChecklistItem';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';

describe('ClearTaskChecklist', () => {
  let repo: InMemorySchedulingRepository;
  let clearUC: ClearTaskChecklist;
  let addUC: AddChecklistItem;
  const TASK_ID = '1';

  beforeEach(() => {
    repo = new InMemorySchedulingRepository();
    clearUC = new ClearTaskChecklist(repo);
    addUC = new AddChecklistItem(repo);
  });

  it('removes all items from checklist', async () => {
    await addUC.execute(TASK_ID, 'Item 1');
    await addUC.execute(TASK_ID, 'Item 2');
    await clearUC.execute(TASK_ID);
    const task = await repo.getTaskWithChecklist(TASK_ID);
    expect(task!.checklist).toHaveLength(0);
  });

  it('no-ops when checklist is already empty', async () => {
    await expect(clearUC.execute(TASK_ID)).resolves.not.toThrow();
  });
});
