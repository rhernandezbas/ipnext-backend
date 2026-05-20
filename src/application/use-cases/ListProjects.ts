import { Project } from '@domain/entities/project';
import { ProjectRepository, ListProjectsFilter } from '@domain/ports/ProjectRepository';

export class ListProjects {
  constructor(private readonly repo: ProjectRepository) {}

  async execute(filter?: ListProjectsFilter): Promise<Project[]> {
    return this.repo.list(filter);
  }
}
