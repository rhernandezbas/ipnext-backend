import { TaskCategory } from '@domain/entities/taskCategory';
import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { prisma } from '../../database/prisma';

function toTaskCategory(row: any): TaskCategory {
  return { id: row.id, name: row.name, description: row.description ?? null };
}

export class PrismaTaskCategoryRepository implements TaskCategoryRepository {
  async list(): Promise<TaskCategory[]> {
    const rows = await (prisma as any).taskCategory.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toTaskCategory);
  }

  async getById(id: string): Promise<TaskCategory | null> {
    const row = await (prisma as any).taskCategory.findUnique({ where: { id } });
    return row ? toTaskCategory(row) : null;
  }

  async getByName(name: string): Promise<TaskCategory | null> {
    const rows = await (prisma as any).taskCategory.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toTaskCategory(row) : null;
  }

  async create(data: { name: string; description: string | null }): Promise<TaskCategory> {
    const row = await (prisma as any).taskCategory.create({ data });
    return toTaskCategory(row);
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<TaskCategory | null> {
    try {
      const row = await (prisma as any).taskCategory.update({ where: { id }, data });
      return toTaskCategory(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).taskCategory.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countTasksUsing(categoryName: string): Promise<number> {
    return (prisma as any).scheduledTask.count({ where: { category: categoryName } });
  }
}
