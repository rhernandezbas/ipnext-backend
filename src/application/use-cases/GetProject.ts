import { Project } from '@domain/entities/project';
import { ProjectRepository } from '@domain/ports/ProjectRepository';

export class GetProject {
  constructor(private readonly repo: ProjectRepository) {}

  async execute(id: string): Promise<Project | null> {
    return this.repo.get(id);
  }
}
