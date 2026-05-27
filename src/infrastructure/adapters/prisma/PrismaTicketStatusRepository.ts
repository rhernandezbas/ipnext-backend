import { TicketStatusCatalog } from '@domain/entities/ticketStatusCatalog';
import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { prisma } from '../../database/prisma';

function toTicketStatusCatalog(row: any): TicketStatusCatalog {
  return { id: row.id, name: row.name, color: row.color, weight: row.weight };
}

export class PrismaTicketStatusRepository implements TicketStatusRepository {
  async list(): Promise<TicketStatusCatalog[]> {
    const rows = await (prisma as any).ticketStatusCatalog.findMany({ orderBy: { weight: 'asc' } });
    return rows.map(toTicketStatusCatalog);
  }

  async getById(id: string): Promise<TicketStatusCatalog | null> {
    const row = await (prisma as any).ticketStatusCatalog.findUnique({ where: { id } });
    return row ? toTicketStatusCatalog(row) : null;
  }

  async getByName(name: string): Promise<TicketStatusCatalog | null> {
    const rows = await (prisma as any).ticketStatusCatalog.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toTicketStatusCatalog(row) : null;
  }

  async create(data: { name: string; color: string; weight: number }): Promise<TicketStatusCatalog> {
    const row = await (prisma as any).ticketStatusCatalog.create({ data });
    return toTicketStatusCatalog(row);
  }

  async update(id: string, data: Partial<{ name: string; color: string; weight: number }>): Promise<TicketStatusCatalog | null> {
    try {
      const row = await (prisma as any).ticketStatusCatalog.update({ where: { id }, data });
      return toTicketStatusCatalog(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).ticketStatusCatalog.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countTicketsUsing(statusName: string): Promise<number> {
    // Phase 2: Ticket.status is a FK relation; count by catalog name via the relation.
    return (prisma as any).ticket.count({ where: { status: { name: statusName } } });
  }
}
