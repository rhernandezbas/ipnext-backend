import { ProjectCategory } from '@domain/entities/projectCategory';
import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';
import { prisma } from '../../database/prisma';

function toProjectCategory(row: any): ProjectCategory {
  return { id: row.id, name: row.name, description: row.description ?? null };
}

export class PrismaProjectCategoryRepository implements ProjectCategoryRepository {
  async list(): Promise<ProjectCategory[]> {
    const rows = await prisma.projectCategory.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toProjectCategory);
  }

  async getById(id: string): Promise<ProjectCategory | null> {
    const row = await prisma.projectCategory.findUnique({ where: { id } });
    return row ? toProjectCategory(row) : null;
  }

  async getByName(name: string): Promise<ProjectCategory | null> {
    const rows = await prisma.projectCategory.findMany();
    const row = rows.find(r => r.name.toLowerCase() === name.toLowerCase());
    return row ? toProjectCategory(row) : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ProjectCategory> {
    const row = await prisma.projectCategory.create({ data });
    return toProjectCategory(row);
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ProjectCategory | null> {
    try {
      const row = await prisma.projectCategory.update({ where: { id }, data });
      return toProjectCategory(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.projectCategory.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countProjectsUsing(_categoryId: string): Promise<number> {
    // Dormant until scheduling-projects-enrich adds Project.categoryId
    return 0;
  }
}
