import { BillingRepository, ListInvoicesQuery } from '@domain/ports/BillingRepository';
import { PaginatedResult } from '../dto/pagination';
import { Invoice } from '@domain/entities/billing';

export class ListInvoices {
  constructor(private readonly repo: BillingRepository) {}

  execute(query: ListInvoicesQuery): Promise<PaginatedResult<Invoice>> {
    return this.repo.listInvoices({ page: query.page ?? 1, limit: query.limit ?? 25, ...query });
  }
}
