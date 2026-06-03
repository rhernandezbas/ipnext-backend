import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { TemplateNotFoundError } from '@domain/errors/checklist';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class AssignTemplateToTask {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly templateRepo: TaskTemplateRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(taskId: string, templateId: string, actor?: ActorContext): Promise<TaskChecklistItem[]> {
    // Verify template exists first — do NOT clear checklist if template not found
    const template = await this.templateRepo.findByIdWithItems(templateId);
    if (!template) {
      throw new TemplateNotFoundError(templateId);
    }
    const items = await this.schedulingRepo.assignTemplateToTask(taskId, templateId);

    if (this.recorder) {
      await this.recorder.record(taskId, 'checklist_template_assigned', {
        actor: actor ?? SYSTEM_ACTOR,
        metadata: { templateId },
      });
    }

    return items;
  }
}
