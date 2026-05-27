import { TicketStatusCatalog } from '../entities/ticketStatusCatalog';

export interface TicketStatusRepository {
  list(): Promise<TicketStatusCatalog[]>;
  getById(id: string): Promise<TicketStatusCatalog | null>;
  getByName(name: string): Promise<TicketStatusCatalog | null>;
  create(data: { name: string; color: string; weight: number }): Promise<TicketStatusCatalog>;
  update(id: string, data: Partial<{ name: string; color: string; weight: number }>): Promise<TicketStatusCatalog | null>;
  delete(id: string): Promise<boolean>;
  countTicketsUsing(statusName: string): Promise<number>;
}
