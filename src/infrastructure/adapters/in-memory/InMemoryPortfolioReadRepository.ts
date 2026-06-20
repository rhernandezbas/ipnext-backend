import type {
  PortfolioReadRepository,
  PortfolioClientRow,
} from '@domain/ports/PortfolioReadRepository';

/**
 * Seed row for the in-memory portfolio repo — one CONTRACT (pre-join).
 * Several rows with the same clientId model a client with multiple contracts.
 */
export interface SeedContract {
  clientId: string;
  clientName: string;
  status: string;
  balanceDue: number | null;
  balanceCurrency: string | null;
  vendedor: string;
  startDate: string; // ISO
}

/**
 * InMemoryPortfolioReadRepository — test seam for PortfolioReadRepository.
 *
 * Stores seeded contracts and reproduces the Prisma adapter's group-by-client
 * semantics: filter by vendedor, dedup by clientId, oldestStartDate = MIN,
 * contractsCount = number of matching contracts. Client-level fields
 * (name/status/balance) are assumed consistent per client (taken from any row).
 */
export class InMemoryPortfolioReadRepository implements PortfolioReadRepository {
  private contracts: SeedContract[] = [];

  /** Add one contract row (test seam). */
  seed(contract: SeedContract): void {
    this.contracts.push(contract);
  }

  async listClientsByVendedor(vendedor: string): Promise<PortfolioClientRow[]> {
    const matching = this.contracts.filter((c) => c.vendedor === vendedor);

    const byClient = new Map<string, PortfolioClientRow>();
    for (const c of matching) {
      const existing = byClient.get(c.clientId);
      if (!existing) {
        byClient.set(c.clientId, {
          clientId: c.clientId,
          clientName: c.clientName,
          status: c.status,
          balanceDue: c.balanceDue,
          balanceCurrency: c.balanceCurrency,
          oldestStartDate: c.startDate,
          contractsCount: 1,
        });
      } else {
        existing.contractsCount += 1;
        if (c.startDate < existing.oldestStartDate) {
          existing.oldestStartDate = c.startDate; // MIN(startDate)
        }
      }
    }

    // Deterministic order — sort by clientName asc.
    return Array.from(byClient.values()).sort((a, b) =>
      a.clientName.localeCompare(b.clientName),
    );
  }
}
