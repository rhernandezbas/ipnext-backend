import { ContractServiceView } from '../entities/contract-service';

export interface ContractServiceRepository {
  getById(id: string): Promise<ContractServiceView | null>;
  /** Find by the UNIQUE (contractId, serviceCatalogId) pair — duplicate pre-check. */
  getByPair(contractId: string, serviceCatalogId: string): Promise<ContractServiceView | null>;
  /** #73 Return ALL rows (active + inactive) for a contract, ordered by createdAt asc. */
  listByContract(contractId: string): Promise<ContractServiceView[]>;
  /**
   * service-transfer — ALL the ACTIVE rows of a catalog whose notes start with `notesPrefix`
   * (oldest first, deterministic). Exists to locate the SOURCE TV slot(s) of a transfer when the
   * caller did not supply sourceContractId: the Gigared-managed row records its CIC in notes
   * ("CIC {cic} · …"), so the slot is resolvable by CIC without a contract id.
   * Fix wave MEDIUM-1: returns EVERY candidate (not a findFirst) — prefix matching only, so the
   * caller MUST re-validate the exact cic per row (cicFromNotes: "CIC 123" also matches
   * "CIC 1234") and handle dirty data (two active rows recording the same cic).
   */
  findActiveByCatalogAndNotesPrefix(serviceCatalogId: string, notesPrefix: string): Promise<ContractServiceView[]>;
  /**
   * gigared-tv-identity-hardening (D4) — batch owner resolver for the operators' accounts list.
   * Returns the ACTIVE managed rows of `serviceCatalogId` whose notes reference any of the
   * given `cics` (Prisma: prefix scan, OR of `startsWith`; the caller re-validates the EXACT
   * cic via `cicFromNotes` when building its lookup map — a prefix collision like "CIC 12"
   * matching "CIC 123" must NOT be trusted as-is). ONE query for the whole batch — N+1 FORBIDDEN
   * (this powers `GET /api/gigared/accounts`, an operators' list endpoint).
   */
  findActiveTvOwnersByCics(serviceCatalogId: string, cics: string[]): Promise<{ notes: string; clientId: string }[]>;
  add(data: { contractId: string; serviceCatalogId: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView>;
  update(id: string, data: { status?: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView | null>;
  /** Returns true when a row was deleted, false when the id did not exist (idempotent caller). */
  delete(id: string): Promise<boolean>;
}
