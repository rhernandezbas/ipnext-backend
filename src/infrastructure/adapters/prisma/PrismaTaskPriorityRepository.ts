import { TaskPriority } from '@domain/entities/taskPriority';
import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { prisma } from '../../database/prisma';

function toTaskPriority(row: any): TaskPriority {
  return { id: row.id, name: row.name, color: row.color, weight: row.weight };
}

export class PrismaTaskPriorityRepository implements TaskPriorityRepository {
  async list(): Promise<TaskPriority[]> {
    const rows = await (prisma as any).taskPriority.findMany({ orderBy: { weight: 'asc' } });
    return rows.map(toTaskPriority);
  }

  async getById(id: string): Promise<TaskPriority | null> {
    const row = await (prisma as any).taskPriority.findUnique({ where: { id } });
    return row ? toTaskPriority(row) : null;
  }

  async getByName(name: string): Promise<TaskPriority | null> {
    const rows = await (prisma as any).taskPriority.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toTaskPriority(row) : null;
  }

  async create(data: { name: string; color: string; weight: number }): Promise<TaskPriority> {
    const row = await (prisma as any).taskPriority.create({ data });
    return toTaskPriority(row);
  }

  async update(id: string, data: Partial<{ name: string; color: string; weight: number }>): Promise<TaskPriority | null> {
    try {
      const row = await (prisma as any).taskPriority.update({ where: { id }, data });
      return toTaskPriority(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).taskPriority.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countTasksUsing(priorityName: string): Promise<number> {
    return (prisma as any).scheduledTask.count({ where: { priority: priorityName } });
  }
}
