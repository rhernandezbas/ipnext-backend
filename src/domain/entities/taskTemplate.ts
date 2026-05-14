export type TaskTemplateCategory = 'installation' | 'repair' | 'maintenance' | 'inspection' | 'other';

export interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  category: TaskTemplateCategory;
}
