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

/**
 * A portfolio row that also carries its owning vendedor — used by the admin
 * "all agents" view. Grouped by (client, vendedor): a single client with
 * contracts under two vendedores yields TWO rows.
 */
export interface PortfolioClientRowWithVendedor extends PortfolioClientRow {
  vendedor: string;
}

export interface PortfolioReadRepository {
  /** Clients (deduplicated) who have >=1 contract with the given vendedor. */
  listClientsByVendedor(vendedor: string): Promise<PortfolioClientRow[]>;

  /**
   * ALL clients that have >=1 contract with a non-null vendedor, grouped by
   * (client, vendedor). One row per combination — a client with contracts under
   * multiple vendedores appears once per vendedor. oldestStartDate = MIN(startDate)
   * within the (client, vendedor) group; contractsCount = contracts in that group.
   * Single round trip (no N+1).
   */
  listAllClientsWithVendedor(): Promise<PortfolioClientRowWithVendedor[]>;
}
