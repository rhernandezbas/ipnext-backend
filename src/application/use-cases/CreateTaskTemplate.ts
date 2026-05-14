import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskTemplate } from '@domain/entities/taskTemplate';

export class CreateTaskTemplate {
  constructor(private readonly repo: TaskTemplateRepository) {}

  execute(data: Omit<TaskTemplate, 'id'>): Promise<TaskTemplate> {
    return this.repo.create(data);
  }
}
