import { TaskTemplate } from '../entities/taskTemplate';
import { TaskTemplateItem } from '../entities/checklist';

export interface TaskTemplateRepository {
  findAll(): Promise<TaskTemplate[]>;
  findById(id: string): Promise<TaskTemplate | null>;
  create(data: Omit<TaskTemplate, 'id'>): Promise<TaskTemplate>;
  update(id: string, data: Partial<Omit<TaskTemplate, 'id'>>): Promise<TaskTemplate | null>;
  delete(id: string): Promise<boolean>;

  replaceItems(
    templateId: string,
    items: { text: string }[]
  ): Promise<TaskTemplateItem[]>;

  findByIdWithItems(id: string): Promise<(TaskTemplate & { items: TaskTemplateItem[] }) | null>;
}
