import { TaskTemplate } from '../entities/taskTemplate';

export interface TaskTemplateRepository {
  findAll(): Promise<TaskTemplate[]>;
  findById(id: string): Promise<TaskTemplate | null>;
  create(data: Omit<TaskTemplate, 'id'>): Promise<TaskTemplate>;
  update(id: string, data: Partial<Omit<TaskTemplate, 'id'>>): Promise<TaskTemplate | null>;
  delete(id: string): Promise<boolean>;
}
