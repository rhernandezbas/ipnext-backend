import { Stage } from '../entities/workflow';

export interface StageRepository {
  listByWorkflow(workflowId: string): Promise<Stage[]>;
  getById(id: string): Promise<Stage | null>;
  add(workflowId: string, data: Pick<Stage, 'name' | 'category' | 'order'>): Promise<Stage>;
  updateColor(stageId: string, color: string): Promise<Stage | null>;
  remove(stageId: string): Promise<boolean>;
  reorder(workflowId: string, orderedIds: string[]): Promise<Stage[]>;
  countTasksUsing(stageId: string): Promise<number>;
  countTasksUsingAny(stageIds: string[]): Promise<number>;
  getDefaultWorkflowStageByLegacyStatus(status: string): Promise<Stage | null>;
}
