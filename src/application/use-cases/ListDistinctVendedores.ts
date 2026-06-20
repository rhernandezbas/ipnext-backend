import { ContractRepository } from '@domain/ports/ContractRepository';

/**
 * ListDistinctVendedores — distinct GR `Contract.vendedor` catalog.
 *
 * Fase 2b (cartera "Mis clientes"). Feeds the FE dropdown for the agente↔vendedor
 * mapping. Non-null, alphabetically ordered — the ordering/distinct is delegated
 * to the adapter (Prisma DISTINCT / in-memory Set).
 */
export class ListDistinctVendedores {
  constructor(private readonly contractRepo: ContractRepository) {}

  async execute(): Promise<string[]> {
    return this.contractRepo.listDistinctVendedores();
  }
}
