import { randomUUID } from 'crypto';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { MaterialConsumptionDto, toMaterialConsumptionDto } from '@application/dto/MaterialConsumptionDto';
import { MaterialNotFoundError, InvalidQuantityError } from '@domain/errors/inventory';
import { StageMaterialDeduction } from '@application/use-cases/StageMaterialDeduction';

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
    // EPIC #38 W6 — optional staging hook; null = deduction feature not wired
    private readonly staging?: {
      stage: StageMaterialDeduction;
      scheduling: SchedulingRepository;
    } | null,
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
      deductedAt: null,
      deductedMovementId: null,
      createdAt: now,
      updatedAt: now,
    });

    // EPIC #38 W6 — best-effort stage hook. Staging failures MUST NOT abort the consumption.
    // Mirrors the W4 side-effect pattern.
    if (this.staging) {
      try {
        const task = await this.staging.scheduling.getTask(input.taskId);
        await this.staging.stage.execute({
          consumptionId: record.id,
          taskId: record.taskId,
          technicianId: task?.assigneeId ?? null,
          materialCatalogId: material.id,
          qty: input.quantity,
        });
      } catch {
        // best-effort — log in prod but never propagate to caller
      }
    }

    return toMaterialConsumptionDto(record, null);
  }
}
