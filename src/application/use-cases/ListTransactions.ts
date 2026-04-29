import { BillingRepository, ListTransactionsQuery } from '@domain/ports/BillingRepository';
import { PaginatedResult } from '../dto/pagination';
import { Transaction } from '@domain/entities/billing';

export class ListTransactions {
  constructor(private readonly repo: BillingRepository) {}

  execute(query: ListTransactionsQuery): Promise<PaginatedResult<Transaction>> {
    return this.repo.listTransactions({ page: query.page ?? 1, limit: query.limit ?? 25, ...query });
  }
}
