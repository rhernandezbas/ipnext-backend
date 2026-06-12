/**
 * Lookups injected into the Gigared use cases (#47).
 * Precedent: AddContractService.ContractLookup → prismaClientLookup('Client'|'Contract', id).
 */
export interface CustomerLookup {
  /**
   * #70 — `grClienteId` (Gestión Real client id) travels back so RegisterGigaredAccount can
   * derive the deterministic TV password (`ip{grClienteId}` padded, #65) server-side. Optional
   * on the shape so the existing callers (link / cancel / packs) that only read `id` keep
   * compiling; absent/null → the register raises GrClientIdRequiredError (422).
   */
  findById(id: string): Promise<{ id: string; grClienteId?: string | null } | null>;
}

/**
 * Contract lookup with OWNERSHIP (#47k HIGH). It returns `clientId` so each use case can assert
 * the contract actually belongs to the target customer before performing any destructive Gigared
 * write. An existence-only lookup let `POST /customers/A/cancel {contractId of B}` reconcile B's
 * contract — a cross-customer write. The use case maps a mismatch to ContractNotFoundError (404),
 * so the foreign contract's existence is never leaked.
 */
export interface ContractLookup {
  findById(id: string): Promise<{ id: string; clientId: string } | null>;
}
