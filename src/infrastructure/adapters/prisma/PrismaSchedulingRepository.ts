import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';
import { StageCategory } from '@domain/entities/workflow';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageNotFoundError } from '@domain/errors/scheduling';
import { prisma } from '../../database/prisma';

// Maps a Stage's category + name to the deprecated status string (REQ-STAGE-DEP-3)
function deriveLegacyStatus(stageCategory: StageCategory, stageName: string): TaskStatus {
  const lowerName = stageName.toLowerCase();
  if (lowerName.includes('cancel') || lowerName.includes('anul')) return 'cancelled';
  if (stageCategory === 'hecho') return 'completed';
  if (stageCategory === 'enProgreso') return 'in_progress';
  return 'pending';
}

export function toTask(row: any): ScheduledTask {
  const stageCategory: StageCategory = row.stage?.category ?? 'nuevo';
  const stageName: string = row.stage?.name ?? '';
  return {
    id: row.id,
    sequenceNumber: row.sequenceNumber,
    title: row.title,
    description: row.description ?? null,
    assignedTo: row.assignedTo ?? null,
    assignedToId: row.assignedToId ?? null,
    clientId: row.clientId ?? null,
    clientName: row.clientName ?? null,
    stageId: row.stageId,
    stageCategory,
    status: deriveLegacyStatus(stageCategory, stageName),
    priority: row.priority,
    scheduledDate: row.scheduledDate ?? null,
    scheduledTime: row.scheduledTime ?? null,
    estimatedHours: row.estimatedHours,
    address: row.address ?? null,
    coordinates: (row.lat != null && row.lng != null)
      ? { lat: row.lat, lng: row.lng }
      : null,
    category: row.category,
    projectId: row.projectId ?? null,
    projectName: row.project?.title ?? null,
    completedAt: row.completedAt
      ? (row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt)
      : null,
    notes: row.notes ?? null,
  };
}

const INCLUDE = { project: true, stage: true } as const;

export class PrismaSchedulingRepository implements SchedulingRepository {
  async listTasks(): Promise<ScheduledTask[]> {
    const rows = await prisma.scheduledTask.findMany({
      orderBy: { createdAt: 'desc' },
      include: INCLUDE,
    });
    return rows.map(toTask);
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    const row = await prisma.scheduledTask.findUnique({
      where: { id },
      include: INCLUDE,
    });
    return row ? toTask(row) : null;
  }

  async createTask(data: Omit<ScheduledTask, 'id' | 'sequenceNumber' | 'stageCategory' | 'status'>): Promise<ScheduledTask> {
    const row = await prisma.scheduledTask.create({
      include: INCLUDE,
      data: {
        title: data.title,
        description: data.description ?? null,
        assignedTo: data.assignedTo ?? null,
        assignedToId: data.assignedToId ?? null,
        clientId: data.clientId ?? null,
        clientName: data.clientName ?? null,
        stageId: data.stageId,
        priority: data.priority,
        scheduledDate: data.scheduledDate,
        scheduledTime: data.scheduledTime,
        estimatedHours: data.estimatedHours,
        address: data.address ?? null,
        lat: data.coordinates?.lat ?? null,
        lng: data.coordinates?.lng ?? null,
        category: data.category,
        projectId: data.projectId ?? null,
        notes: data.notes ?? null,
        completedAt: data.completedAt ? new Date(data.completedAt) : null,
      },
    });
    return toTask(row);
  }

  async updateTask(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    try {
      const row = await prisma.scheduledTask.update({
        where: { id },
        include: INCLUDE,
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.assignedTo !== undefined && { assignedTo: data.assignedTo }),
          ...(data.assignedToId !== undefined && { assignedToId: data.assignedToId }),
          ...(data.clientId !== undefined && { clientId: data.clientId }),
          ...(data.clientName !== undefined && { clientName: data.clientName }),
          ...(data.stageId !== undefined && { stageId: data.stageId }),
          ...(data.priority !== undefined && { priority: data.priority }),
          ...(data.scheduledDate !== undefined && { scheduledDate: data.scheduledDate }),
          ...(data.scheduledTime !== undefined && { scheduledTime: data.scheduledTime }),
          ...(data.estimatedHours !== undefined && { estimatedHours: data.estimatedHours }),
          ...(data.address !== undefined && { address: data.address }),
          ...(data.coordinates !== undefined && {
            lat: data.coordinates?.lat ?? null,
            lng: data.coordinates?.lng ?? null,
          }),
          ...(data.category !== undefined && { category: data.category }),
          ...(data.projectId !== undefined && { projectId: data.projectId }),
          ...(data.notes !== undefined && { notes: data.notes }),
          ...(data.completedAt !== undefined && {
            completedAt: data.completedAt ? new Date(data.completedAt) : null,
          }),
        },
      });
      return toTask(row);
    } catch {
      return null;
    }
  }

  async deleteTask(id: string): Promise<boolean> {
    try {
      await prisma.scheduledTask.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null> {
    // Explicitly check the target stage exists before attempting the update.
    // This surfaces STAGE_NOT_FOUND rather than masking it as TASK_NOT_FOUND.
    const targetStage = await prisma.stage.findUnique({ where: { id: stageId } });
    if (!targetStage) {
      throw new StageNotFoundError(stageId);
    }

    try {
      const currentTask = await prisma.scheduledTask.findUnique({ where: { id }, select: { completedAt: true } });

      const shouldSetCompletedAt =
        targetStage.category === 'hecho' && !currentTask?.completedAt;

      const row = await prisma.scheduledTask.update({
        where: { id },
        include: INCLUDE,
        data: {
          stageId,
          ...(shouldSetCompletedAt && { completedAt: new Date() }),
        },
      });
      return toTask(row);
    } catch {
      return null;
    }
  }

  /** @deprecated use moveTaskToStage */
  async updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null> {
    console.warn('deprecated: PrismaSchedulingRepository.updateTaskStatus — use moveTaskToStage');
    // Map legacy status to Default workflow stage
    const stageName = {
      pending: 'Nuevo',
      in_progress: 'En progreso',
      completed: 'Hecho',
      cancelled: 'Anulado-Cancelado',
    }[status];

    try {
      const defaultWorkflow = await prisma.workflow.findFirst({
        where: { name: { equals: 'Default', mode: 'insensitive' } },
        include: { stages: true },
      });
      const stage = defaultWorkflow?.stages.find(s => s.name === stageName);
      if (!stage) {
        throw new StageNotFoundError(`default-workflow-stage-for-status:${status}`);
      }
      return this.moveTaskToStage(id, stage.id);
    } catch (err) {
      if (err instanceof StageNotFoundError) throw err;
      return null;
    }
  }
}
