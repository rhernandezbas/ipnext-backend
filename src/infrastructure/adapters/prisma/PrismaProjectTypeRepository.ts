import { ProjectType } from '@domain/entities/projectType';
import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';
import { prisma } from '../../database/prisma';

function toProjectType(row: any): ProjectType {
  return { id: row.id, name: row.name, description: row.description ?? null };
}

export class PrismaProjectTypeRepository implements ProjectTypeRepository {
  async list(): Promise<ProjectType[]> {
    const rows = await prisma.projectType.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toProjectType);
  }

  async getById(id: string): Promise<ProjectType | null> {
    const row = await prisma.projectType.findUnique({ where: { id } });
    return row ? toProjectType(row) : null;
  }

  async getByName(name: string): Promise<ProjectType | null> {
    const rows = await prisma.projectType.findMany();
    const row = rows.find(r => r.name.toLowerCase() === name.toLowerCase());
    return row ? toProjectType(row) : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ProjectType> {
    const row = await prisma.projectType.create({ data });
    return toProjectType(row);
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ProjectType | null> {
    try {
      const row = await prisma.projectType.update({ where: { id }, data });
      return toProjectType(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.projectType.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countProjectsUsing(_typeId: string): Promise<number> {
    // Dormant until scheduling-projects-enrich adds Project.typeId
    return 0;
  }
}
