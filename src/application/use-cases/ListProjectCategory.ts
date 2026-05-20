import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { ProjectCategory } from '@domain/entities/projectCategory';

export class ListProjectCategory {
  constructor(private readonly repo: ProjectCategoryRepository) {}
  async execute(): Promise<ProjectCategory[]> {
    return this.repo.list();
  }
}
