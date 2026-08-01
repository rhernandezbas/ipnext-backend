import { randomUUID } from 'crypto';
import { TicketAreaCatalog } from '@domain/entities/ticket-area-catalog';
import { TicketAreaCatalogRepository, TicketAreaCatalogWriteData } from '@domain/ports/TicketAreaCatalogRepository';

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

  async create(data: TicketAreaCatalogWriteData): Promise<TicketAreaCatalog> {
    const item: TicketAreaCatalog = {
      id: randomUUID(),
      name: data.name,
      color: data.color,
      // portal-ticket-topic — mismos defaults que la columna Prisma (el lado SEGURO).
      portalVisible: data.portalVisible ?? false,
      portalLabel: data.portalLabel ?? null,
      portalDescription: data.portalDescription ?? null,
      portalOrder: data.portalOrder ?? 0,
    };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<TicketAreaCatalogWriteData>): Promise<TicketAreaCatalog | null> {
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

  /** portal-ticket-topic — mirror del WHERE portalVisible=true del adapter Prisma. */
  async listPortalVisible(): Promise<TicketAreaCatalog[]> {
    return this.items
      .filter(i => i.portalVisible)
      .sort((a, b) => a.portalOrder - b.portalOrder || a.name.localeCompare(b.name))
      .map(i => ({ ...i }));
  }

  /** portal-ticket-topic — autoridad: null si no existe O si portalVisible es false. */
  async getPortalVisibleById(id: string): Promise<TicketAreaCatalog | null> {
    const item = this.items.find(i => i.id === id && i.portalVisible);
    return item ? { ...item } : null;
  }
}
