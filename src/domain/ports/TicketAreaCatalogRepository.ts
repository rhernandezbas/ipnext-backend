import { TicketAreaCatalog } from '../entities/ticket-area-catalog';

export interface TicketAreaCatalogRepository {
  list(): Promise<TicketAreaCatalog[]>;
  getById(id: string): Promise<TicketAreaCatalog | null>;
  getByName(name: string): Promise<TicketAreaCatalog | null>;
  create(data: { name: string }): Promise<TicketAreaCatalog>;
  update(id: string, data: Partial<{ name: string }>): Promise<TicketAreaCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many Ticket rows reference this area id (delete guard). */
  countInUse(areaId: string): Promise<number>;
}
