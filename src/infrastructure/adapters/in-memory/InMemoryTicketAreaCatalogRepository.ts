import { randomUUID } from 'crypto';
import { TicketAreaCatalog } from '@domain/entities/ticket-area-catalog';
import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';

export class InMemoryTicketAreaCatalogRepository implements TicketAreaCatalogRepository {
  private items: TicketAreaCatalog[] = [];
  /** Test seam: tickets-per-area-id counts for the DeleteTicketArea guard. */
  public ticketCounts: Record<string, number> = {};

  async list(): Promise<TicketAreaCatalog[]> {
    return [...this.items].map(i => ({ ...i }));
  }

  async getById(id: string): Promise<TicketAreaCatalog | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<TicketAreaCatalog | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; color: string }): Promise<TicketAreaCatalog> {
    const item: TicketAreaCatalog = { id: randomUUID(), ...data };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; color: string }>): Promise<TicketAreaCatalog | null> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index]!, ...data };
    return { ...this.items[index]! };
  }

  async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  async countInUse(areaId: string): Promise<number> {
    return this.ticketCounts[areaId] ?? 0;
  }
}
