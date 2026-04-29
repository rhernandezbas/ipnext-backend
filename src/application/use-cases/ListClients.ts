import { CustomerRepository, ListClientsQuery } from '@domain/ports/CustomerRepository';
import { PaginatedResult } from '../dto/pagination';
import { Customer } from '@domain/entities/customer';

export class ListClients {
  constructor(private readonly repo: CustomerRepository) {}

  execute(query: ListClientsQuery): Promise<PaginatedResult<Customer>> {
    return this.repo.list({
      page: query.page ?? 1,
      limit: query.limit ?? 25,
      search: query.search,
      status: query.status,
    });
  }
}
