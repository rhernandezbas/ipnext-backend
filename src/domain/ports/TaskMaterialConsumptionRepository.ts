import { TaskMaterialConsumption } from '../entities/task-material-consumption';

export interface TaskMaterialConsumptionRepository {
  listByTask(taskId: string): Promise<TaskMaterialConsumption[]>;
  create(consumption: TaskMaterialConsumption): Promise<TaskMaterialConsumption>;
  delete(id: string): Promise<boolean>;
}
