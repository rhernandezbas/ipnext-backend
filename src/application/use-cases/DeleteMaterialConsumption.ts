import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import { MaterialConsumptionNotFoundError } from '@domain/errors/inventory';

/** Deletes a material consumption record by id. Throws MaterialConsumptionNotFoundError if not found. */
export class DeleteMaterialConsumption {
  constructor(private readonly consumptions: TaskMaterialConsumptionRepository) {}

  async execute(id: string): Promise<void> {
    const deleted = await this.consumptions.delete(id);
    if (!deleted) throw new MaterialConsumptionNotFoundError(id);
  }
}
