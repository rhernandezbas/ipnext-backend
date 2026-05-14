import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskTemplate } from '@domain/entities/taskTemplate';

export class ListTaskTemplates {
  constructor(private readonly repo: TaskTemplateRepository) {}

  execute(): Promise<TaskTemplate[]> {
    return this.repo.findAll();
  }
}
