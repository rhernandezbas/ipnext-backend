import { MonthlyBillingRepository } from '@domain/ports/MonthlyBillingRepository';
import { MonthlyBillingResponse } from '@domain/entities/billing';

export class GetMonthlyBilling {
  constructor(private readonly repo: MonthlyBillingRepository) {}

  execute(): Promise<MonthlyBillingResponse> {
    return this.repo.getMonthly();
  }
}
