import { BillingSummary, Invoice, Payment, Transaction } from '../entities/billing';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

export interface ListInvoicesQuery extends PaginatedQuery {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export interface ListTransactionsQuery extends PaginatedQuery {
  dateFrom?: string;
  dateTo?: string;
}

export interface BillingRepository {
  getSummary(): Promise<BillingSummary>;
  listInvoices(query: ListInvoicesQuery): Promise<PaginatedResult<Invoice>>;
  listPayments(query: PaginatedQuery & { search?: string }): Promise<PaginatedResult<Payment>>;
  listTransactions(query: ListTransactionsQuery): Promise<PaginatedResult<Transaction>>;
}
