import { AddChecklistItem } from '@application/use-cases/AddChecklistItem';
import { UpdateChecklistItem } from '@application/use-cases/UpdateChecklistItem';
import { ToggleChecklistItem } from '@application/use-cases/ToggleChecklistItem';
import { RemoveChecklistItem } from '@application/use-cases/RemoveChecklistItem';
import { ReorderChecklistItems } from '@application/use-cases/ReorderChecklistItems';
import { ClearTaskChecklist } from '@application/use-cases/ClearTaskChecklist';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

function seeded() {
  const repo = new InMemorySchedulingRepository();
  repo.seedTask({ id: 'task-1' });
  const recorder = new FakeTaskActivityRecorder();
  return { repo, recorder };
}

describe('Checklist activity (D.8–D.14)', () => {
  it('AddChecklistItem → checklist_item_added (D.8)', async () => {
    const { repo, recorder } = seeded();
    const item = await new AddChecklistItem(repo, recorder).execute('task-1', 'Buy cable', ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-1',
        type: 'checklist_item_added',
        payload: expect.objectContaining({ actor: ACTOR, toValue: { text: 'Buy cable' }, metadata: { itemId: item!.id } }),
      }),
    );
  });

  it('UpdateChecklistItem → checklist_item_updated, taskId from the item (D.9)', async () => {
    const { repo, recorder } = seeded();
    const item = await repo.addChecklistItem('task-1', 'old');
    await new UpdateChecklistItem(repo, recorder).execute(item.id, 'new', ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-1',
        type: 'checklist_item_updated',
        payload: expect.objectContaining({ toValue: { text: 'new' }, metadata: { itemId: item.id } }),
      }),
    );
  });

  it('ToggleChecklistItem → checklist_item_toggled with done (D.10)', async () => {
    const { repo, recorder } = seeded();
    const item = await repo.addChecklistItem('task-1', 'x');
    await new ToggleChecklistItem(repo, recorder).execute(item.id, ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-1',
        type: 'checklist_item_toggled',
        payload: expect.objectContaining({ toValue: { done: true }, metadata: { itemId: item.id } }),
      }),
    );
  });

  it('RemoveChecklistItem → checklist_item_removed, taskId threaded (D.11)', async () => {
    const { repo, recorder } = seeded();
    const item = await repo.addChecklistItem('task-1', 'x');
    await new RemoveChecklistItem(repo, recorder).execute(item.id, 'task-1', ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-1',
        type: 'checklist_item_removed',
        payload: expect.objectContaining({ metadata: { itemId: item.id } }),
      }),
    );
  });

  it('ReorderChecklistItems → checklist_reordered (D.12)', async () => {
    const { repo, recorder } = seeded();
    const a = await repo.addChecklistItem('task-1', 'a');
    const b = await repo.addChecklistItem('task-1', 'b');
    await new ReorderChecklistItems(repo, recorder).execute('task-1', [b.id, a.id], ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-1',
        type: 'checklist_reordered',
        payload: expect.objectContaining({ metadata: { orderedIds: [b.id, a.id] } }),
      }),
    );
  });

  it('ClearTaskChecklist → checklist_cleared (D.14)', async () => {
    const { repo, recorder } = seeded();
    await repo.addChecklistItem('task-1', 'x');
    await new ClearTaskChecklist(repo, recorder).execute('task-1', ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({ taskId: 'task-1', type: 'checklist_cleared', payload: expect.objectContaining({ actor: ACTOR }) }),
    );
  });
});
