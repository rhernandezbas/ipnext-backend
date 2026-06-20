/**
 * PortfolioReadRepository — domain port (Mis clientes, Fase 3).
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 *
 * Why a NEW port instead of overloading ContractRepository:
 * ContractRepository.list returns already-joined ContractListItem rows WITHOUT
 * client status/balance and WITHOUT per-row vendedor in the DTO. The portfolio
 * is a distinct read concern: it aggregates Contract + Client BY CLIENT
 * (deduplicated), filtered by the agent's vendedor name. This mirrors the
 * project's feature-specific read-repo pattern.
 */

/** One deduplicated client in an agent's portfolio. */
export interface PortfolioClientRow {
  clientId: string;
  clientName: string;
  /** ClientStatus value: 'active' | 'late' | 'blocked' | 'inactive' | 'baja'. */
  status: string;
  /** Decimal converted to number; null = never fetched / no balance. */
  balanceDue: number | null;
  balanceCurrency: string | null;
  /** ISO — MIN(Contract.startDate) among that client's contracts with this vendedor. */
  oldestStartDate: string;
  /** Count of that client's contracts with this vendedor. */
  contractsCount: number;
}

export interface PortfolioReadRepository {
  /** Clients (deduplicated) who have >=1 contract with the given vendedor. */
  listClientsByVendedor(vendedor: string): Promise<PortfolioClientRow[]>;
}
