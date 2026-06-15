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
   *
   * #81 — `tvActivationSeq` (contador de reactivaciones de TV por cliente) viaja de vuelta para
   * que TODOS los use cases resuelvan el internal_id VIGENTE vía currentTvInternalId(id, seq) en
   * vez del Client.id pelado. Opcional → absent/null se trata como seq=0 (identidad de hoy,
   * back-compat: los callers/tests que no lo proveen siguen compilando y comportándose igual).
   */
  findById(
    id: string,
  ): Promise<{ id: string; grClienteId?: string | null; tvActivationSeq?: number | null } | null>;
}

/**
 * Contract lookup with OWNERSHIP (#47k HIGH). It returns `clientId` so each use case can assert
 * the contract actually belongs to the target customer before performing any destructive Gigared
 * write. An existence-only lookup let `POST /customers/A/cancel {contractId of B}` reconcile B's
 * contract — a cross-customer write. The use case maps a mismatch to ContractNotFoundError (404),
 * so the foreign contract's existence is never leaked.
 */
export interface ContractLookup {
  /**
   * #115 — grContratoId is now included so RegisterGigaredAccount can derive the deterministic
   * TV identity (email + password) from the contract, not the customer's grClienteId.
   * Optional on the shape so existing callers (link / cancel / packs / change-password) that
   * only read `id` / `clientId` keep compiling without changes.
   */
  findById(id: string): Promise<{ id: string; clientId: string; grContratoId?: string | null } | null>;
}
