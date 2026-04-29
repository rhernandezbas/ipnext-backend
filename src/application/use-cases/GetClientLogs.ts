import { CustomerRepository, ListLogsQuery } from '@domain/ports/CustomerRepository';
import { ClientLog } from '@domain/entities/customer';
import { PaginatedResult } from '../dto/pagination';

export class GetClientLogs {
  constructor(private readonly repo: CustomerRepository) {}

  execute(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>> {
    return this.repo.listLogs({
      clientId: query.clientId,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    });
  }
}
