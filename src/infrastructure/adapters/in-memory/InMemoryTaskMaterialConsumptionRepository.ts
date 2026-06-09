import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';

export class InMemoryTaskMaterialConsumptionRepository implements TaskMaterialConsumptionRepository {
  readonly store = new Map<string, TaskMaterialConsumption>();

  async listByTask(taskId: string): Promise<TaskMaterialConsumption[]> {
    return Array.from(this.store.values()).filter(c => c.taskId === taskId);
  }

  async create(consumption: TaskMaterialConsumption): Promise<TaskMaterialConsumption> {
    const row: TaskMaterialConsumption = {
      ...consumption,
      deductedAt: consumption.deductedAt ?? null,
      deductedMovementId: consumption.deductedMovementId ?? null,
    };
    this.store.set(consumption.id, { ...row });
    return { ...row };
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async findById(id: string): Promise<TaskMaterialConsumption | null> {
    const c = this.store.get(id);
    return c ? { ...c } : null;
  }

  async stampDeduction(id: string, deductedAt: Date, deductedMovementId: string): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, deductedAt, deductedMovementId, updatedAt: new Date().toISOString() });
  }
}
