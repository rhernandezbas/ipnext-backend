import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { ProjectType } from '@domain/entities/projectType';
import { ProjectTypeNotFoundError, ProjectTypeNameConflictError } from '@domain/errors/scheduling';

export class UpdateProjectType {
  constructor(private readonly repo: ProjectTypeRepository) {}
  async execute(id: string, data: { name?: string; description?: string | null }): Promise<ProjectType> {
    const item = await this.repo.getById(id);
    if (!item) throw new ProjectTypeNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new ProjectTypeNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new ProjectTypeNotFoundError(id);
    return updated;
  }
}
