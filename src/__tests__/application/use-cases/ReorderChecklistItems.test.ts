import { ReorderChecklistItems } from '../../../application/use-cases/ReorderChecklistItems';
import { AddChecklistItem } from '../../../application/use-cases/AddChecklistItem';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { OrderingError } from '../../../domain/errors/checklist';

describe('ReorderChecklistItems', () => {
  let repo: InMemorySchedulingRepository;
  let reorderUC: ReorderChecklistItems;
  let addUC: AddChecklistItem;
  const TASK_ID = '1';

  beforeEach(() => {
    repo = new InMemorySchedulingRepository();
    reorderUC = new ReorderChecklistItems(repo);
    addUC = new AddChecklistItem(repo);
  });

  async function setupItems() {
    const a = await addUC.execute(TASK_ID, 'A');
    const b = await addUC.execute(TASK_ID, 'B');
    const c = await addUC.execute(TASK_ID, 'C');
    return [a!.id, b!.id, c!.id];
  }

  it('renumbers 0..N-1 in new order', async () => {
    const [aId, bId, cId] = await setupItems();
    const result = await reorderUC.execute(TASK_ID, [cId, aId, bId]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe(cId);
    expect(result[0].order).toBe(0);
    expect(result[1].id).toBe(aId);
    expect(result[1].order).toBe(1);
    expect(result[2].id).toBe(bId);
    expect(result[2].order).toBe(2);
  });

  it('throws OrderingError for foreign id (id not in task)', async () => {
    const [aId, bId, cId] = await setupItems();
    await expect(reorderUC.execute(TASK_ID, [aId, bId, cId, 'foreign-id']))
      .rejects.toThrow(OrderingError);
  });

  it('throws OrderingError when an existing id is missing from orderedIds', async () => {
    const [aId, _bId, cId] = await setupItems();
    await expect(reorderUC.execute(TASK_ID, [aId, cId])) // missing bId
      .rejects.toThrow(OrderingError);
  });
});
