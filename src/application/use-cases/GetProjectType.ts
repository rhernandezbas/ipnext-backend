import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { ProjectType } from '@domain/entities/projectType';
import { ProjectTypeNotFoundError } from '@domain/errors/scheduling';

export class GetProjectType {
  constructor(private readonly repo: ProjectTypeRepository) {}
  async execute(id: string): Promise<ProjectType> {
    const item = await this.repo.getById(id);
    if (!item) throw new ProjectTypeNotFoundError(id);
    return item;
  }
}
