import { BillingRepository } from '@domain/ports/BillingRepository';
import { BillingSummary } from '@domain/entities/billing';

export class GetBillingSummary {
  constructor(private readonly repo: BillingRepository) {}

  execute(): Promise<BillingSummary> {
    return this.repo.getSummary();
  }
}
