export interface TaskTemplateItem {
  id: string;
  templateId: string;
  text: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskChecklistItem {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  order: number;
  fromTemplateItemId: string | null;
  createdAt: string;
  updatedAt: string;
}
