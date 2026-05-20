import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { ProjectCategoryNotFoundError, ProjectCategoryInUseError } from '@domain/errors/scheduling';

export class DeleteProjectCategory {
  constructor(private readonly repo: ProjectCategoryRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new ProjectCategoryNotFoundError(id);

    // Defensive check — dormant until scheduling-projects-enrich adds Project.categoryId
    const count = await this.repo.countProjectsUsing(id);
    if (count > 0) throw new ProjectCategoryInUseError(count);

    await this.repo.delete(id);
  }
}
