import { randomUUID } from 'crypto';
import { TicketStatusCatalog } from '@domain/entities/ticketStatusCatalog';
import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';

export class InMemoryTicketStatusRepository implements TicketStatusRepository {
  private items: TicketStatusCatalog[] = [];
  /** Test seam: tickets-per-status-name counts for the DeleteTicketStatus guard. */
  public ticketCounts: Record<string, number> = {};

  async list(): Promise<TicketStatusCatalog[]> {
    return [...this.items].sort((a, b) => a.weight - b.weight).map(i => ({ ...i }));
  }

  async getById(id: string): Promise<TicketStatusCatalog | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<TicketStatusCatalog | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; color: string; weight: number }): Promise<TicketStatusCatalog> {
    const item: TicketStatusCatalog = { id: randomUUID(), ...data };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; color: string; weight: number }>): Promise<TicketStatusCatalog | null> {
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

  async countTicketsUsing(statusName: string): Promise<number> {
    return this.ticketCounts[statusName] ?? 0;
  }
}
