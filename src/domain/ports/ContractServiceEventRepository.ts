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

export interface ContractServiceEventRepository {
  /** Append a new event. Best-effort callers wrap in try/catch. */
  record(input: RecordContractServiceEventInput): Promise<ContractServiceEvent>;
  /** List events for a contract, newest-first (callers re-sort as needed). */
  listByContract(contractId: string): Promise<ContractServiceEvent[]>;
}
