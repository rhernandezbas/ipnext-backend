import { Workflow, Stage } from '../entities/workflow';

export interface WorkflowRepository {
  list(): Promise<Workflow[]>;
  getById(id: string): Promise<Workflow | null>;
  getByName(name: string): Promise<Workflow | null>;
  create(data: {
    name: string;
    description: string | null;
    stages: Array<Pick<Stage, 'name' | 'category' | 'order'>>;
  }): Promise<Workflow>;
  update(id: string, data: Partial<Pick<Workflow, 'name' | 'description'>>): Promise<Workflow | null>;
  delete(id: string): Promise<boolean>;
}
