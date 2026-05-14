import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskTemplate } from '@domain/entities/taskTemplate';

export class UpdateTaskTemplate {
  constructor(private readonly repo: TaskTemplateRepository) {}

  execute(id: string, data: Partial<Omit<TaskTemplate, 'id'>>): Promise<TaskTemplate | null> {
    return this.repo.update(id, data);
  }
}
