import { Stage, StageCategory } from '../entities/workflow';

export interface UpdateStageData {
  name?: string;
  category?: StageCategory;
}

export interface StageRepository {
  listByWorkflow(workflowId: string): Promise<Stage[]>;
  getById(id: string): Promise<Stage | null>;
  add(workflowId: string, data: Pick<Stage, 'name' | 'code' | 'category' | 'order'>): Promise<Stage>;
  findByCode(code: string, workflowId: string): Promise<Stage | null>;
  updateColor(stageId: string, color: string): Promise<Stage | null>;
  /** Updates name and/or category. code, order, and color are immutable via this method. */
  updateStage(stageId: string, data: UpdateStageData): Promise<Stage | null>;
  remove(stageId: string): Promise<boolean>;
  reorder(workflowId: string, orderedIds: string[]): Promise<Stage[]>;
  countTasksUsing(stageId: string): Promise<number>;
  countTasksUsingAny(stageIds: string[]): Promise<number>;
  getDefaultWorkflowStageByLegacyStatus(status: string): Promise<Stage | null>;
}
