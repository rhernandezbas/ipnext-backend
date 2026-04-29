import { MonthlyBillingResponse } from '../entities/billing';

export interface MonthlyBillingRepository {
  getMonthly(): Promise<MonthlyBillingResponse>;
}
