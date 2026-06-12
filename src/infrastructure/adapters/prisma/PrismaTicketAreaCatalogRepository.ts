import { TicketAreaCatalog } from '@domain/entities/ticket-area-catalog';
import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { prisma } from '../../database/prisma';

function toTicketAreaCatalog(row: any): TicketAreaCatalog {
  return { id: row.id, name: row.name, color: row.color };
}

export class PrismaTicketAreaCatalogRepository implements TicketAreaCatalogRepository {
  async list(): Promise<TicketAreaCatalog[]> {
    const rows = await (prisma as any).ticketAreaCatalog.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toTicketAreaCatalog);
  }

  async getById(id: string): Promise<TicketAreaCatalog | null> {
    const row = await (prisma as any).ticketAreaCatalog.findUnique({ where: { id } });
    return row ? toTicketAreaCatalog(row) : null;
  }

  async getByName(name: string): Promise<TicketAreaCatalog | null> {
    const rows = await (prisma as any).ticketAreaCatalog.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toTicketAreaCatalog(row) : null;
  }

  async create(data: { name: string; color: string }): Promise<TicketAreaCatalog> {
    const row = await (prisma as any).ticketAreaCatalog.create({ data });
    return toTicketAreaCatalog(row);
  }

  async update(id: string, data: Partial<{ name: string; color: string }>): Promise<TicketAreaCatalog | null> {
    try {
      const row = await (prisma as any).ticketAreaCatalog.update({ where: { id }, data });
      return toTicketAreaCatalog(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).ticketAreaCatalog.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countInUse(areaId: string): Promise<number> {
    return (prisma as any).ticket.count({ where: { areaId } });
  }
}
