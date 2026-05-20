import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { ProjectTypeNotFoundError, ProjectTypeInUseError } from '@domain/errors/scheduling';

export class DeleteProjectType {
  constructor(private readonly repo: ProjectTypeRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new ProjectTypeNotFoundError(id);

    // Defensive check — dormant until scheduling-projects-enrich adds Project.typeId
    const count = await this.repo.countProjectsUsing(id);
    if (count > 0) throw new ProjectTypeInUseError(count);

    await this.repo.delete(id);
  }
}
