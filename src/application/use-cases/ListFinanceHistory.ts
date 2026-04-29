import { FinanceHistoryRepository, FinanceHistoryFilter } from '@domain/ports/FinanceHistoryRepository';
import { FinanceHistoryEvent } from '@domain/entities/financeHistory';

export class ListFinanceHistory {
  constructor(private readonly repo: FinanceHistoryRepository) {}

  execute(filter?: FinanceHistoryFilter): Promise<FinanceHistoryEvent[]> {
    return this.repo.findAll(filter);
  }
}
