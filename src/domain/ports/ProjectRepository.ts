import { Project } from '@domain/entities/project';

export interface ProjectRepository {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(data: Pick<Project, 'title' | 'description'>): Promise<Project>;
  update(id: string, data: Partial<Pick<Project, 'title' | 'description'>>): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
}
