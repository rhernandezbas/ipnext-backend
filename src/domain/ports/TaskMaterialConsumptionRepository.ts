import { TaskMaterialConsumption } from '../entities/task-material-consumption';

export interface TaskMaterialConsumptionRepository {
  listByTask(taskId: string): Promise<TaskMaterialConsumption[]>;
  create(consumption: TaskMaterialConsumption): Promise<TaskMaterialConsumption>;
  delete(id: string): Promise<boolean>;
  /** Retrieve a single consumption by id. */
  findById(id: string): Promise<TaskMaterialConsumption | null>;
  /**
   * EPIC #38 W6 — stamp deductedAt + deductedMovementId on the consumption row.
   * Called inside the ConfirmMaterialDeduction UnitOfWork transaction.
   */
  stampDeduction(id: string, deductedAt: Date, deductedMovementId: string): Promise<void>;
}
