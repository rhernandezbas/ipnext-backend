import { ProjectCategory } from '../entities/projectCategory';

export interface ProjectCategoryRepository {
  list(): Promise<ProjectCategory[]>;
  getById(id: string): Promise<ProjectCategory | null>;
  getByName(name: string): Promise<ProjectCategory | null>;
  create(data: { name: string; description: string | null }): Promise<ProjectCategory>;
  update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ProjectCategory | null>;
  delete(id: string): Promise<boolean>;
  countProjectsUsing(categoryId: string): Promise<number>;
}
