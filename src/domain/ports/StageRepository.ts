import { Stage } from '../entities/workflow';
import { TaskStatus } from '../entities/scheduling';

export interface StageRepository {
  listByWorkflow(workflowId: string): Promise<Stage[]>;
  getById(id: string): Promise<Stage | null>;
  add(workflowId: string, data: Pick<Stage, 'name' | 'category' | 'order'>): Promise<Stage>;
  remove(stageId: string): Promise<boolean>;
  reorder(workflowId: string, orderedIds: string[]): Promise<Stage[]>;
  countTasksUsing(stageId: string): Promise<number>;
  countTasksUsingAny(stageIds: string[]): Promise<number>;
  getDefaultWorkflowStageByLegacyStatus(status: TaskStatus): Promise<Stage | null>;
}
