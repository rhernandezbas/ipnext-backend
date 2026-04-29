import { Customer, Service, ClientLog } from '../entities/customer';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

export interface ListClientsQuery extends PaginatedQuery {
  search?: string;
  status?: string;
}

export interface ListLogsQuery extends PaginatedQuery {
  clientId: string;
}

export interface CustomerRepository {
  list(query: ListClientsQuery): Promise<PaginatedResult<Customer>>;
  findById(id: string): Promise<Customer>;
  listServices(clientId: string): Promise<Service[]>;
  listInvoices(clientId: string): Promise<import('../entities/billing').Invoice[]>;
  listLogs(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>>;
}
