import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { ProjectCategory } from '@domain/entities/projectCategory';
import { ProjectCategoryNotFoundError, ProjectCategoryNameConflictError } from '@domain/errors/scheduling';

export class UpdateProjectCategory {
  constructor(private readonly repo: ProjectCategoryRepository) {}
  async execute(id: string, data: { name?: string; description?: string | null }): Promise<ProjectCategory> {
    const item = await this.repo.getById(id);
    if (!item) throw new ProjectCategoryNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new ProjectCategoryNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new ProjectCategoryNotFoundError(id);
    return updated;
  }
}
