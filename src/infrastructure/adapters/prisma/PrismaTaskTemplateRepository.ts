import { TaskTemplate, TaskTemplateCategory } from '@domain/entities/taskTemplate';
import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { prisma } from '../../database/prisma';

export function toTaskTemplate(row: any): TaskTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    category: row.category as TaskTemplateCategory,
  };
}

export class PrismaTaskTemplateRepository implements TaskTemplateRepository {
  async findAll(): Promise<TaskTemplate[]> {
    const rows = await prisma.taskTemplate.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toTaskTemplate);
  }

  async findById(id: string): Promise<TaskTemplate | null> {
    const row = await prisma.taskTemplate.findUnique({ where: { id } });
    return row ? toTaskTemplate(row) : null;
  }

  async create(data: Omit<TaskTemplate, 'id'>): Promise<TaskTemplate> {
    const row = await prisma.taskTemplate.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        category: data.category,
      },
    });
    return toTaskTemplate(row);
  }

  async update(id: string, data: Partial<Omit<TaskTemplate, 'id'>>): Promise<TaskTemplate | null> {
    try {
      const row = await prisma.taskTemplate.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.category !== undefined && { category: data.category }),
        },
      });
      return toTaskTemplate(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.taskTemplate.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
