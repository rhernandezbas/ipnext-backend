import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { TemplateNotFoundError } from '@domain/errors/checklist';

export class AssignTemplateToTask {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly templateRepo: TaskTemplateRepository,
  ) {}

  async execute(taskId: string, templateId: string): Promise<TaskChecklistItem[]> {
    // Verify template exists first — do NOT clear checklist if template not found
    const template = await this.templateRepo.findByIdWithItems(templateId);
    if (!template) {
      throw new TemplateNotFoundError(templateId);
    }
    return this.schedulingRepo.assignTemplateToTask(taskId, templateId);
  }
}
