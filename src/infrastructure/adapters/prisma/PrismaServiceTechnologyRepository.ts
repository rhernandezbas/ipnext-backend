import { ServiceTechnology } from '@domain/entities/serviceTechnology';
import { ServiceTechnologyRepository } from '@domain/ports/ServiceTechnologyRepository';
import { prisma } from '../../database/prisma';

function toServiceTechnology(row: any): ServiceTechnology {
  return { id: row.id, name: row.name, description: row.description ?? null };
}

export class PrismaServiceTechnologyRepository implements ServiceTechnologyRepository {
  async list(): Promise<ServiceTechnology[]> {
    const rows = await (prisma as any).serviceTechnology.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toServiceTechnology);
  }

  async getById(id: string): Promise<ServiceTechnology | null> {
    const row = await (prisma as any).serviceTechnology.findUnique({ where: { id } });
    return row ? toServiceTechnology(row) : null;
  }

  async getByName(name: string): Promise<ServiceTechnology | null> {
    const rows = await (prisma as any).serviceTechnology.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toServiceTechnology(row) : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ServiceTechnology> {
    const row = await (prisma as any).serviceTechnology.create({ data });
    return toServiceTechnology(row);
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ServiceTechnology | null> {
    try {
      const row = await (prisma as any).serviceTechnology.update({ where: { id }, data });
      return toServiceTechnology(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).serviceTechnology.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countServicesUsingTechnology(name: string): Promise<number> {
    // Service.technology stores the technology name as a free-text column (Phase 1, no FK).
    return (prisma as any).service.count({ where: { technology: name } });
  }
}
