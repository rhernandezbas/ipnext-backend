import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';

export class InMemoryTaskMaterialConsumptionRepository implements TaskMaterialConsumptionRepository {
  private store = new Map<string, TaskMaterialConsumption>();

  async listByTask(taskId: string): Promise<TaskMaterialConsumption[]> {
    return Array.from(this.store.values()).filter(c => c.taskId === taskId);
  }

  async create(consumption: TaskMaterialConsumption): Promise<TaskMaterialConsumption> {
    this.store.set(consumption.id, { ...consumption });
    return { ...consumption };
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}
