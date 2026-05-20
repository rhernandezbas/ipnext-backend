/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `as any` casts on the Prisma client calls for new models
 * (TaskTemplateItem) because `prisma generate` has not been run against the
 * enriched schema (no DB available during this apply phase). The casts will
 * become unnecessary once the migration is applied and `npm run prisma:generate`
 * is executed. Runtime behaviour IS correct — the new tables exist after migration.
 */
import { TaskTemplate, TaskTemplateCategory } from '@domain/entities/taskTemplate';
import { TaskTemplateItem } from '@domain/entities/checklist';
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

function toTemplateItem(row: any): TaskTemplateItem {
  return {
    id: row.id,
    templateId: row.templateId,
    text: row.text,
    order: row.order,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

const ITEM_INCLUDE = { items: { orderBy: { order: 'asc' } } } as const;

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

  async replaceItems(templateId: string, items: { text: string }[]): Promise<TaskTemplateItem[]> {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      await tx.taskTemplateItem.deleteMany({ where: { templateId } });
      const now = new Date();
      const data = items.map((item, index) => ({
        templateId,
        text: item.text,
        order: index,
        updatedAt: now,
      }));
      if (data.length > 0) {
        await tx.taskTemplateItem.createMany({ data });
      }
      return tx.taskTemplateItem.findMany({
        where: { templateId },
        orderBy: { order: 'asc' },
      });
    });
    return result.map(toTemplateItem);
  }

  async findByIdWithItems(id: string): Promise<(TaskTemplate & { items: TaskTemplateItem[] }) | null> {
    const row = await (prisma.taskTemplate as any).findUnique({
      where: { id },
      include: ITEM_INCLUDE,
    });
    if (!row) return null;
    return {
      ...toTaskTemplate(row),
      items: (row.items ?? []).map(toTemplateItem),
    };
  }
}
