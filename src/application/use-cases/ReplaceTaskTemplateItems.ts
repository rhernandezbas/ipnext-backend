import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskTemplateItem } from '@domain/entities/checklist';
import { TemplateNotFoundError } from '@domain/errors/checklist';

export class ReplaceTaskTemplateItems {
  constructor(private readonly templateRepo: TaskTemplateRepository) {}

  async execute(templateId: string, items: { text: string }[]): Promise<TaskTemplateItem[]> {
    const template = await this.templateRepo.findByIdWithItems(templateId);
    if (!template) {
      throw new TemplateNotFoundError(templateId);
    }
    return this.templateRepo.replaceItems(templateId, items);
  }
}
