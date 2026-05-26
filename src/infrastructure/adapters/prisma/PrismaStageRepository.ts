import { Stage } from '@domain/entities/workflow';
import { TaskStatus } from '@domain/entities/scheduling';
import { StageRepository } from '@domain/ports/StageRepository';
import { prisma } from '../../database/prisma';

const LEGACY_STATUS_TO_STAGE_NAME: Record<TaskStatus, string> = {
  pending: 'Nuevo',
  in_progress: 'En progreso',
  completed: 'Hecho',
  cancelled: 'Anulado-Cancelado',
};

function toStage(row: any): Stage {
  return {
    id: row.id,
    workflowId: row.workflowId,
    name: row.name,
    category: row.category,
    order: row.order,
    color: row.color ?? null,
  };
}

export class PrismaStageRepository implements StageRepository {
  async listByWorkflow(workflowId: string): Promise<Stage[]> {
    const rows = await prisma.stage.findMany({
      where: { workflowId },
      orderBy: { order: 'asc' },
    });
    return rows.map(toStage);
  }

  async getById(id: string): Promise<Stage | null> {
    const row = await prisma.stage.findUnique({ where: { id } });
    return row ? toStage(row) : null;
  }

  async add(workflowId: string, data: Pick<Stage, 'name' | 'category' | 'order'>): Promise<Stage> {
    const row = await prisma.stage.create({
      data: {
        workflowId,
        name: data.name,
        category: data.category as any,
        order: data.order,
      },
    });
    return toStage(row);
  }

  async updateColor(stageId: string, color: string): Promise<Stage | null> {
    try {
      const row = await (prisma.stage as any).update({ where: { id: stageId }, data: { color } });
      return toStage(row);
    } catch {
      return null;
    }
  }

  async remove(stageId: string): Promise<boolean> {
    try {
      await prisma.stage.delete({ where: { id: stageId } });
      return true;
    } catch {
      return false;
    }
  }

  async reorder(workflowId: string, orderedIds: string[]): Promise<Stage[]> {
    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.stage.update({ where: { id }, data: { order: index } }),
      ),
    );
    const rows = await prisma.stage.findMany({
      where: { workflowId },
      orderBy: { order: 'asc' },
    });
    return rows.map(toStage);
  }

  async countTasksUsing(stageId: string): Promise<number> {
    return prisma.scheduledTask.count({ where: { stageId } });
  }

  async countTasksUsingAny(stageIds: string[]): Promise<number> {
    return prisma.scheduledTask.count({ where: { stageId: { in: stageIds } } });
  }

  async getDefaultWorkflowStageByLegacyStatus(status: TaskStatus): Promise<Stage | null> {
    const stageName = LEGACY_STATUS_TO_STAGE_NAME[status];
    const row = await prisma.stage.findFirst({
      where: {
        name: stageName,
        workflow: { name: { equals: 'Default', mode: 'insensitive' } },
      },
    });
    return row ? toStage(row) : null;
  }
}
