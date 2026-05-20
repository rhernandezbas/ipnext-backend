import { RemoveChecklistItem } from '../../../application/use-cases/RemoveChecklistItem';
import { AddChecklistItem } from '../../../application/use-cases/AddChecklistItem';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';

describe('RemoveChecklistItem', () => {
  let repo: InMemorySchedulingRepository;
  let removeUC: RemoveChecklistItem;
  let addUC: AddChecklistItem;
  const TASK_ID = '1';

  beforeEach(() => {
    repo = new InMemorySchedulingRepository();
    removeUC = new RemoveChecklistItem(repo);
    addUC = new AddChecklistItem(repo);
  });

  it('removes item and returns true', async () => {
    const added = await addUC.execute(TASK_ID, 'To remove');
    const result = await removeUC.execute(added!.id);
    expect(result).toBe(true);
  });

  it('returns false for unknown itemId', async () => {
    const result = await removeUC.execute('nonexistent');
    expect(result).toBe(false);
  });
});
