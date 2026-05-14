import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskTemplate } from '@domain/entities/taskTemplate';

export class GetTaskTemplate {
  constructor(private readonly repo: TaskTemplateRepository) {}

  execute(id: string): Promise<TaskTemplate | null> {
    return this.repo.findById(id);
  }
}
