export interface ListInvoicesQueryDto {
  page?: number;
  limit?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ListTransactionsQueryDto {
  page?: number;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface ListPaymentsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
}
