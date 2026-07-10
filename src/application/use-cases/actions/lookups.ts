/**
 * Lookups injected into the actions-worklist use cases (W2).
 * Precedent: gigared/lookups.ts → prismaClientLookup('Client', id) / userLookupForScheduling.
 */

/** Resolves a Client mirror row to id+name — wired to prismaClientLookup('Client', id). */
export interface ClientNameLookup {
  findById(id: string): Promise<{ id: string; name?: string | null } | null>;
}

/** Resolves an RbacUser to id+name (reviewer trail) — wired to userLookupForScheduling. */
export interface UserNameLookup {
  findById(id: string): Promise<{ id: string; name?: string | null } | null>;
}

/**
 * H1b — narrow ownership read for the set-target validation of
 * UpdateOwnershipCase: does the contract exist in the mirror, is it in baja,
 * and whose client is it. STRUCTURAL slice of ContractPairingReader.getContract
 * — both adapters (Prisma/InMemory) satisfy it as-is, no dedicated adapter.
 * Decision documented in design §5: one read method total (getContract) reused
 * by the detector re-pair (H1a) and this validation, ISP preserved because the
 * use case only sees this 3-field slice.
 */
export interface ContractOwnershipLookup {
  getContract(id: string): Promise<{ id: string; clientId: string; status: string } | null>;
}
