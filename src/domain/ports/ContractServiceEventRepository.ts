/**
 * ContractServiceEventRepository — domain port for the non-TV contract service history log (#110).
 *
 * Records every activated / deactivated / reactivated event for a NON-TV contract service.
 * The log is append-only: record() inserts a new row, no updates or deletes.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */

export type ServiceEventType = 'activated' | 'deactivated' | 'reactivated' | 'reduced' | 'blocked' | 'restored' | 'modified';

export interface RecordContractServiceEventInput {
  contractId: string;
  serviceCatalogId: string;
  eventType: ServiceEventType;
  actorId?: string | null;
  actorName?: string;
  notes?: string | null;
  // #127 - optional cancellation reason.
  reason?: string | null;
}

export interface ContractServiceEvent {
  id: string;
  contractId: string;
  serviceCatalogId: string;
  eventType: ServiceEventType;
  actorId: string | null;
  actorName: string;
  notes: string | null;
  // #127 - optional cancellation reason; null for legacy events.
  reason: string | null;
  createdAt: string; // ISO string
}

/**
 * internet-history — event row enriched with the contract's client (resolved via JOIN
 * contract_service_events → Contract → Client). Used by the GLOBAL history list so the
 * use case never re-queries per row. customerName is best-effort (may be null).
 */
export interface ContractServiceEventWithClient extends ContractServiceEvent {
  clientId: string | null;
  customerName: string | null;
}

/**
 * internet-history — cross-contract filters for the GLOBAL events list. `serviceCatalogId`
 * narrows to a single service (e.g. the INTERNET catalog id), which is how the history page
 * isolates internet events from TV/other-service events.
 */
export interface ListContractServiceEventsFilter {
  serviceCatalogId?: string;
  contractId?: string;
  /**
   * internet-history — narrows to events whose contract is in this set (SQL `contractId IN (...)`).
   * Push-down filter so the createdBy enrichment of a page is bounded by the page's contracts,
   * NOT by the full historical event count. An empty array yields no rows.
   */
  contractIds?: string[];
  clientId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
}

export interface ContractServiceEventRepository {
  /** Append a new event. Best-effort callers wrap in try/catch. */
  record(input: RecordContractServiceEventInput): Promise<ContractServiceEvent>;
  /** List events for a contract, newest-first (callers re-sort as needed). */
  listByContract(contractId: string): Promise<ContractServiceEvent[]>;
  /**
   * internet-history — GLOBAL list with optional cross-contract filters, newest-first,
   * enriched with the contract's client (clientId + customerName via JOIN). Mirrors the
   * TvActivationEventRepository.list() shape so the internet history page mirrors TV.
   */
  list(filters: ListContractServiceEventsFilter): Promise<ContractServiceEventWithClient[]>;
}
