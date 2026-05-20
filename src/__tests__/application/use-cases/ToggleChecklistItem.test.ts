import { ToggleChecklistItem } from '../../../application/use-cases/ToggleChecklistItem';
import { AddChecklistItem } from '../../../application/use-cases/AddChecklistItem';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ChecklistItemNotFoundError } from '../../../domain/errors/checklist';

describe('ToggleChecklistItem', () => {
  let repo: InMemorySchedulingRepository;
  let toggleUC: ToggleChecklistItem;
  let addUC: AddChecklistItem;
  const TASK_ID = '1';

  beforeEach(() => {
    repo = new InMemorySchedulingRepository();
    toggleUC = new ToggleChecklistItem(repo);
    addUC = new AddChecklistItem(repo);
  });

  it('toggles false → true', async () => {
    const added = await addUC.execute(TASK_ID, 'Check me');
    const toggled = await toggleUC.execute(added!.id);
    expect(toggled.done).toBe(true);
    expect(toggled.id).toBe(added!.id);
  });

  it('toggles true → false', async () => {
    const added = await addUC.execute(TASK_ID, 'Check me');
    await toggleUC.execute(added!.id); // true
    const back = await toggleUC.execute(added!.id); // false
    expect(back.done).toBe(false);
  });

  it('throws ChecklistItemNotFoundError for unknown itemId', async () => {
    await expect(toggleUC.execute('nonexistent'))
      .rejects.toThrow(ChecklistItemNotFoundError);
  });
});
