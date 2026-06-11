/**
 * Existence-only lookups injected into the Gigared use cases (#47).
 * Precedent: AddContractService.ContractLookup → prismaClientLookup('Client'|'Contract', id).
 */
export interface CustomerLookup {
  findById(id: string): Promise<{ id: string } | null>;
}

export interface ContractLookup {
  findById(id: string): Promise<{ id: string } | null>;
}
