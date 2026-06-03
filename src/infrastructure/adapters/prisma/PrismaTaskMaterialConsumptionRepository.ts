import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import { prisma } from '../../database/prisma';

function toEntity(row: any): TaskMaterialConsumption {
  return {
    id: row.id,
    taskId: row.taskId,
    materialCatalogId: row.materialCatalogId,
    materialName: row.materialName,
    quantity: row.quantity,
    unit: row.unit ?? null,
    notes: row.notes ?? null,
    recordedByUserId: row.recordedByUserId ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

export class PrismaTaskMaterialConsumptionRepository implements TaskMaterialConsumptionRepository {
  async listByTask(taskId: string): Promise<TaskMaterialConsumption[]> {
    const rows = await (prisma as any).taskMaterialConsumption.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toEntity);
  }

  async create(consumption: TaskMaterialConsumption): Promise<TaskMaterialConsumption> {
    const row = await (prisma as any).taskMaterialConsumption.create({
      data: {
        id: consumption.id,
        taskId: consumption.taskId,
        materialCatalogId: consumption.materialCatalogId,
        materialName: consumption.materialName,
        quantity: consumption.quantity,
        unit: consumption.unit,
        notes: consumption.notes,
        recordedByUserId: consumption.recordedByUserId,
        createdAt: new Date(consumption.createdAt),
        updatedAt: new Date(consumption.updatedAt),
      },
    });
    return toEntity(row);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).taskMaterialConsumption.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
