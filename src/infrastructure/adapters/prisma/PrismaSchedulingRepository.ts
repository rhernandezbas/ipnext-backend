import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { prisma } from '../../database/prisma';

function toTask(row: any): ScheduledTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    assignedTo: row.assignedTo ?? null,
    assignedToId: row.assignedToId ?? null,
    clientId: row.clientId ?? null,
    clientName: row.clientName ?? null,
    status: row.status as TaskStatus,
    priority: row.priority,
    scheduledDate: row.scheduledDate,
    scheduledTime: row.scheduledTime,
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

export class InMemorySchedulingRepository implements SchedulingRepository {
  async listTasks(): Promise<ScheduledTask[]> {
    const rows = await prisma.scheduledTask.findMany({
      orderBy: { createdAt: 'desc' },
      include: { project: true },
    });
    return rows.map(toTask);
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    const row = await prisma.scheduledTask.findUnique({
      where: { id },
      include: { project: true },
    });
    return row ? toTask(row) : null;
  }

  async createTask(data: Omit<ScheduledTask, 'id'>): Promise<ScheduledTask> {
    const row = await prisma.scheduledTask.create({
      include: { project: true },
      data: {
        title: data.title,
        description: data.description ?? null,
        assignedTo: data.assignedTo ?? null,
        assignedToId: data.assignedToId ?? null,
        clientId: data.clientId ?? null,
        clientName: data.clientName ?? null,
        status: data.status,
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
        include: { project: true },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.assignedTo !== undefined && { assignedTo: data.assignedTo }),
          ...(data.assignedToId !== undefined && { assignedToId: data.assignedToId }),
          ...(data.clientId !== undefined && { clientId: data.clientId }),
          ...(data.clientName !== undefined && { clientName: data.clientName }),
          ...(data.status !== undefined && { status: data.status }),
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

  async updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null> {
    try {
      const row = await prisma.scheduledTask.update({
        where: { id },
        data: {
          status,
          ...(status === 'completed' && { completedAt: new Date() }),
        },
      });
      return toTask(row);
    } catch {
      return null;
    }
  }
}
