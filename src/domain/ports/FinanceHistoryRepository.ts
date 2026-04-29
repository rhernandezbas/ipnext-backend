import { FinanceHistoryEvent } from '../entities/financeHistory';

export interface FinanceHistoryFilter {
  clientId?: string;
  from?: string;
  to?: string;
}

export interface FinanceHistoryRepository {
  findAll(filter?: FinanceHistoryFilter): Promise<FinanceHistoryEvent[]>;
}
