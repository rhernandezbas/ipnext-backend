import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { ProjectType } from '@domain/entities/projectType';

export class ListProjectType {
  constructor(private readonly repo: ProjectTypeRepository) {}
  async execute(): Promise<ProjectType[]> {
    return this.repo.list();
  }
}
