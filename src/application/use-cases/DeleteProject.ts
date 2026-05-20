import { ProjectRepository } from '@domain/ports/ProjectRepository';

export class DeleteProject {
  constructor(private readonly repo: ProjectRepository) {}

  async execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
