export type StageCategory = 'nuevo' | 'enProgreso' | 'hecho';

export interface Stage {
  id: string;
  workflowId: string;
  name: string;
  /** Immutable business identity slug. Set on creation, never editable. */
  code: string;
  category: StageCategory;
  order: number;
  /** Editable hex colour for the stage badge. Null → UI falls back to category colour. */
  color: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  stages: Stage[]; // sorted by `order` asc
  createdAt: string;
  updatedAt: string;
}
