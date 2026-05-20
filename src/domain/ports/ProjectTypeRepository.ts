import { ProjectType } from '../entities/projectType';

export interface ProjectTypeRepository {
  list(): Promise<ProjectType[]>;
  getById(id: string): Promise<ProjectType | null>;
  getByName(name: string): Promise<ProjectType | null>;
  create(data: { name: string; description: string | null }): Promise<ProjectType>;
  update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ProjectType | null>;
  delete(id: string): Promise<boolean>;
  countProjectsUsing(typeId: string): Promise<number>;
}
