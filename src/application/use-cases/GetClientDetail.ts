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

    // On-demand refresh: for ANY client with a GR link (not just debtors) so every
    // opened ficha syncs its balance AND invoices. TTL-gated inside the collaborator;
    // on a stale client it AWAITS a live GR fetch (up to timeoutMs, default 4s) — this
    // adds latency to the first open per TTL window (accepted cost of "all clients"),
    // but errors/timeouts are swallowed so it never THROWS or breaks the ficha.
    if (this.balanceRefresh && customer.grClienteId) {
      const refreshed = await this.balanceRefresh.execute({
        grClienteId: customer.grClienteId,
        lastBalanceAt: customer.lastBalanceAt,
        // fix wave F7 — el carril del status decide el TTL. Sin esto, la ficha
        // de una `baja` se muestra fresca (TTL 26h) pero igual golpea GR cada
        // 60min: el gate visible y el gate real discrepando en silencio.
        status: customer.status,
      });

      // If GR gave us fresh data, re-load so the caller sees the updated balance
      if (refreshed) {
        return this.repo.findById(id);
      }
    }

    return customer;
  }
}
