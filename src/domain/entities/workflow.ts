export type StageCategory = 'nuevo' | 'enProgreso' | 'hecho';

export interface Stage {
  id: string;
  workflowId: string;
  name: string;
  category: StageCategory;
  order: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  stages: Stage[]; // sorted by `order` asc
  createdAt: string;
  updatedAt: string;
}
