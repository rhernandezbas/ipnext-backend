import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { Customer } from '@domain/entities/customer';
import { RefreshClientBalanceIfStale } from './RefreshClientBalanceIfStale';

export class GetClientDetail {
  constructor(
    private readonly repo: CustomerRepository,
    private readonly balanceRefresh?: RefreshClientBalanceIfStale,
  ) {}

  async execute(id: string): Promise<Customer> {
    // First load — may have a stale balance
    const customer = await this.repo.findById(id);

    // On-demand refresh: only for debtors, only if we have the collaborator
    if (this.balanceRefresh && customer.status === 'late' && customer.grClienteId) {
      const refreshed = await this.balanceRefresh.execute({
        grClienteId: customer.grClienteId,
        lastBalanceAt: customer.lastBalanceAt,
      });

      // If GR gave us fresh data, re-load so the caller sees the updated balance
      if (refreshed) {
        return this.repo.findById(id);
      }
    }

    return customer;
  }
}
