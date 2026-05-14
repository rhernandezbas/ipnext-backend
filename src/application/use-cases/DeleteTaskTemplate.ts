import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';

export class DeleteTaskTemplate {
  constructor(private readonly repo: TaskTemplateRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
