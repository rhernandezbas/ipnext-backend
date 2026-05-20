import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { ProjectCategory } from '@domain/entities/projectCategory';
import { ProjectCategoryNameConflictError } from '@domain/errors/scheduling';

export class CreateProjectCategory {
  constructor(private readonly repo: ProjectCategoryRepository) {}
  async execute(data: { name: string; description?: string | null }): Promise<ProjectCategory> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new ProjectCategoryNameConflictError(data.name);
    return this.repo.create({ name: data.name, description: data.description ?? null });
  }
}
