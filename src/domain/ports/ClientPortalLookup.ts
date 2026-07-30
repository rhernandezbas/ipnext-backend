/**
 * ClientPortalLookup — domain port (customer-portal-api, Fase 3, task 3.1).
 *
 * Narrow port (ISP — same criterion as `CampaignRecipientLookup` /
 * `ManualRecipientSource` in `CustomerRepository.ts`): the portal-admin CRUD
 * only ever needs a client's `name` (display) and `documento` (DNI default) —
 * never the full `Customer` entity. A dedicated narrow port means the admin
 * use cases don't drag in the entire `CustomerRepository` surface (list/stats/
 * contracts/invoices/...) just to check "does this client exist".
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
export interface ClientPortalLookupResult {
  id: string;
  name: string;
  /** Parsed via `extractPortalDni` from `Client.customAttributes`. */
  documento: string | null;
}

export interface ClientPortalNameResult {
  id: string;
  name: string;
}

export interface ClientPortalLookup {
  /** Single client — CreatePortalAccount: existence check + dni default. */
  findById(clientId: string): Promise<ClientPortalLookupResult | null>;
  /**
   * Batch — ListPortalAccounts: joins client names onto the account list.
   * Returns only the ids that exist (subset, any order) — same contract as
   * `ManualRecipientSource.findRecipientCandidatesByIds`.
   */
  findNamesByIds(clientIds: string[]): Promise<ClientPortalNameResult[]>;
}
