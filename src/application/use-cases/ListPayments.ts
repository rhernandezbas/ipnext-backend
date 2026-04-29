import { BillingRepository } from '@domain/ports/BillingRepository';
import { PaginatedQuery } from '../dto/pagination';
import { PaginatedResult } from '../dto/pagination';
import { Payment } from '@domain/entities/billing';

export class ListPayments {
  constructor(private readonly repo: BillingRepository) {}

  execute(query: PaginatedQuery & { search?: string }): Promise<PaginatedResult<Payment>> {
    return this.repo.listPayments({ page: query.page ?? 1, limit: query.limit ?? 25, search: query.search });
  }
}
