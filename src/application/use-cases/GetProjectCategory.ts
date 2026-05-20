import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { ProjectCategory } from '@domain/entities/projectCategory';
import { ProjectCategoryNotFoundError } from '@domain/errors/scheduling';

export class GetProjectCategory {
  constructor(private readonly repo: ProjectCategoryRepository) {}
  async execute(id: string): Promise<ProjectCategory> {
    const item = await this.repo.getById(id);
    if (!item) throw new ProjectCategoryNotFoundError(id);
    return item;
  }
}
