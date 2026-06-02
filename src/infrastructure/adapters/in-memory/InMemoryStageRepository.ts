import { randomUUID } from 'crypto';
import { Stage } from '@domain/entities/workflow';
import { StageRepository } from '@domain/ports/StageRepository';

// Legacy status → stage name mapping
const LEGACY_STATUS_TO_STAGE_NAME: Record<string, string> = {
  pending: 'Nuevo',
  in_progress: 'En progreso',
  completed: 'Hecho',
  cancelled: 'Anulado-Cancelado',
};

export class InMemoryStageRepository implements StageRepository {
  private stages: Stage[] = [];
  // taskStageIds: returns list of stageIds used by tasks (injected to support countTasksUsing)
  private taskStageIds: () => string[] | Promise<string[]>;

  constructor(taskStageIds: () => string[] | Promise<string[]> = () => []) {
    this.taskStageIds = taskStageIds;
  }

  async listByWorkflow(workflowId: string): Promise<Stage[]> {
    return this.stages
      .filter(s => s.workflowId === workflowId)
      .sort((a, b) => a.order - b.order)
      .map(s => ({ ...s }));
  }

  async getById(id: string): Promise<Stage | null> {
    const s = this.stages.find(s => s.id === id);
    return s ? { ...s } : null;
  }

  async add(workflowId: string, data: Pick<Stage, 'name' | 'code' | 'category' | 'order'>): Promise<Stage> {
    const stage: Stage = {
      id: randomUUID(),
      workflowId,
      name: data.name,
      code: data.code,
      category: data.category,
      order: data.order,
      color: null,
    };
    this.stages.push(stage);
    return { ...stage };
  }

  async findByCode(code: string, workflowId: string): Promise<Stage | null> {
    const s = this.stages.find(s => s.code === code && s.workflowId === workflowId);
    return s ? { ...s } : null;
  }

  async updateColor(stageId: string, color: string): Promise<Stage | null> {
    const s = this.stages.find(s => s.id === stageId);
    if (!s) return null;
    s.color = color;
    return { ...s };
  }

  async remove(stageId: string): Promise<boolean> {
    const index = this.stages.findIndex(s => s.id === stageId);
    if (index === -1) return false;
    this.stages.splice(index, 1);
    return true;
  }

  async reorder(workflowId: string, orderedIds: string[]): Promise<Stage[]> {
    orderedIds.forEach((id, index) => {
      const s = this.stages.find(s => s.id === id && s.workflowId === workflowId);
      if (s) s.order = index;
    });
    return this.stages
      .filter(s => s.workflowId === workflowId)
      .sort((a, b) => a.order - b.order)
      .map(s => ({ ...s }));
  }

  async countTasksUsing(stageId: string): Promise<number> {
    const ids = await this.taskStageIds();
    return ids.filter(id => id === stageId).length;
  }

  async countTasksUsingAny(stageIds: string[]): Promise<number> {
    const ids = await this.taskStageIds();
    const set = new Set(stageIds);
    return ids.filter(id => set.has(id)).length;
  }

  async getDefaultWorkflowStageByLegacyStatus(status: string): Promise<Stage | null> {
    const stageName = LEGACY_STATUS_TO_STAGE_NAME[status];
    // Find Default workflow's stage with this name — for in-memory, we look up by stage name
    // across all stages (the test is responsible for setting up the Default workflow stages)
    const s = this.stages.find(s => s.name === stageName);
    return s ? { ...s } : null;
  }

  // Helper for tests: add a stage directly (bypasses workflowId lookup)
  addDirect(stage: Stage): void {
    this.stages.push({ ...stage });
  }

  // Helper: resolve a stage by name (used by InMemorySchedulingRepository.getStageByName)
  // When workflowId is provided, the lookup is scoped to that workflow.
  async findByName(name: string, workflowId?: string): Promise<Stage | null> {
    const s = this.stages.find(s => s.name === name && (workflowId == null || s.workflowId === workflowId));
    return s ? { ...s } : null;
  }
}
