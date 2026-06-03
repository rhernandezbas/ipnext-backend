import { randomUUID } from 'crypto';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { MaterialConsumptionDto, toMaterialConsumptionDto } from '@application/dto/MaterialConsumptionDto';
import { MaterialNotFoundError, InvalidQuantityError } from '@domain/errors/inventory';

export interface RecordMaterialConsumptionInput {
  taskId: string;
  materialCatalogId: string;
  quantity: number;
  unit?: string | null;
  notes?: string | null;
  recordedByUserId?: string | null;
}

/** Records a material consumption for a task. Snapshots materialName from the catalog. */
export class RecordMaterialConsumption {
  constructor(
    private readonly consumptions: TaskMaterialConsumptionRepository,
    private readonly materials: MaterialCatalogRepository,
  ) {}

  async execute(input: RecordMaterialConsumptionInput): Promise<MaterialConsumptionDto> {
    if (input.quantity <= 0) throw new InvalidQuantityError();

    const material = await this.materials.getById(input.materialCatalogId);
    if (!material) throw new MaterialNotFoundError(input.materialCatalogId);

    const now = new Date().toISOString();
    const record = await this.consumptions.create({
      id: randomUUID(),
      taskId: input.taskId,
      materialCatalogId: material.id,
      materialName: material.name,        // snapshot
      quantity: input.quantity,
      unit: input.unit !== undefined ? input.unit : material.unit,  // prefer input.unit ?? material.unit
      notes: input.notes ?? null,
      recordedByUserId: input.recordedByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return toMaterialConsumptionDto(record, null);
  }
}
