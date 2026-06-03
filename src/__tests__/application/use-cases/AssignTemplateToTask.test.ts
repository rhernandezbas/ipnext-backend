import { AssignTemplateToTask } from '../../../application/use-cases/AssignTemplateToTask';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryTaskTemplateRepository } from '../../../infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository';
import { AddChecklistItem } from '../../../application/use-cases/AddChecklistItem';
import { ReplaceTaskTemplateItems } from '../../../application/use-cases/ReplaceTaskTemplateItems';
import { TemplateNotFoundError } from '../../../domain/errors/checklist';
import { FakeTaskActivityRecorder } from '../../helpers/FakeTaskActivityRecorder';

describe('AssignTemplateToTask', () => {
  let schedRepo: InMemorySchedulingRepository;
  let templateRepo: InMemoryTaskTemplateRepository;
  let useCase: AssignTemplateToTask;
  const TASK_ID = '1';
  const TEMPLATE_ID = '1';

  beforeEach(() => {
    templateRepo = new InMemoryTaskTemplateRepository();
    schedRepo = new InMemorySchedulingRepository(undefined, templateRepo);
    useCase = new AssignTemplateToTask(schedRepo, templateRepo);
  });

  it('clears existing checklist and clones template items with fromTemplateItemId set', async () => {
    // Add existing checklist item to task
    const addUC = new AddChecklistItem(schedRepo);
    await addUC.execute(TASK_ID, 'Old item');

    // Add template items
    const replaceUC = new ReplaceTaskTemplateItems(templateRepo);
    await replaceUC.execute(TEMPLATE_ID, [
      { text: 'Template Step 1' },
      { text: 'Template Step 2' },
    ]);

    const result = await useCase.execute(TASK_ID, TEMPLATE_ID);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Template Step 1');
    expect(result[0].done).toBe(false);
    expect(result[0].fromTemplateItemId).toBeTruthy();
    expect(result[1].text).toBe('Template Step 2');
    expect(result[1].fromTemplateItemId).toBeTruthy();
  });

  it('clears checklist when template has no items', async () => {
    const addUC = new AddChecklistItem(schedRepo);
    await addUC.execute(TASK_ID, 'To be cleared');

    // Assign template with empty items
    const result = await useCase.execute(TASK_ID, TEMPLATE_ID);
    expect(result).toHaveLength(0);
  });

  it('throws TemplateNotFoundError and does NOT clear checklist', async () => {
    const addUC = new AddChecklistItem(schedRepo);
    await addUC.execute(TASK_ID, 'Preserved item');

    await expect(useCase.execute(TASK_ID, 'nonexistent-template'))
      .rejects.toThrow(TemplateNotFoundError);

    // Checklist should still have the existing item
    const taskWithChecklist = await schedRepo.getTaskWithChecklist(TASK_ID);
    expect(taskWithChecklist!.checklist).toHaveLength(1);
    expect(taskWithChecklist!.checklist[0].text).toBe('Preserved item');
  });

  it('emits checklist_template_assigned (D.13)', async () => {
    const recorder = new FakeTaskActivityRecorder();
    const uc = new AssignTemplateToTask(schedRepo, templateRepo, recorder);
    const replaceUC = new ReplaceTaskTemplateItems(templateRepo);
    await replaceUC.execute(TEMPLATE_ID, [{ text: 'Step 1' }]);

    await uc.execute(TASK_ID, TEMPLATE_ID, { actorId: 'u1', actorName: 'Alice' });

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: TASK_ID,
        type: 'checklist_template_assigned',
        payload: expect.objectContaining({
          actor: { actorId: 'u1', actorName: 'Alice' },
          metadata: { templateId: TEMPLATE_ID },
        }),
      }),
    );
  });
});
