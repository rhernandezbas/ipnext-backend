import { UpdateChecklistItem } from '../../../application/use-cases/UpdateChecklistItem';
import { AddChecklistItem } from '../../../application/use-cases/AddChecklistItem';
import { ToggleChecklistItem } from '../../../application/use-cases/ToggleChecklistItem';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ChecklistItemNotFoundError } from '../../../domain/errors/checklist';

describe('UpdateChecklistItem', () => {
  let repo: InMemorySchedulingRepository;
  let updateUC: UpdateChecklistItem;
  let addUC: AddChecklistItem;
  let toggleUC: ToggleChecklistItem;
  const TASK_ID = '1';

  beforeEach(() => {
    repo = new InMemorySchedulingRepository();
    updateUC = new UpdateChecklistItem(repo);
    addUC = new AddChecklistItem(repo);
    toggleUC = new ToggleChecklistItem(repo);
  });

  it('updates text, preserves done and order', async () => {
    const added = await addUC.execute(TASK_ID, 'Original');
    await toggleUC.execute(added!.id); // done = true
    const updated = await updateUC.execute(added!.id, 'Updated text');
    expect(updated.text).toBe('Updated text');
    expect(updated.done).toBe(true);
    expect(updated.order).toBe(added!.order);
  });

  it('throws ChecklistItemNotFoundError for unknown itemId', async () => {
    await expect(updateUC.execute('nonexistent', 'New text'))
      .rejects.toThrow(ChecklistItemNotFoundError);
  });
});
