/**
 * TvActivationEventRepository — domain port for the TV activation history log (#5 BE).
 *
 * Records every alta / baja / reactivacion event for a client's TV account.
 * The log is append-only: record() inserts a new row, no updates or deletes.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */

export type TvEventType = 'alta' | 'baja' | 'reactivacion';

export interface RecordTvActivationEventInput {
  clientId: string;
  actorId: string | null;
  actorName: string;
  eventType: TvEventType;
  /** Gigared CIC for the account at the time of the event. Optional (e.g. baja before CIC resolve). */
  cic?: string | null;
  /** Gigared internal_id used for this registration cycle. */
  internalId?: string | null;
  /** Seq used for this activation cycle (0 = primera alta, >0 = reactivacion). */
  seq?: number | null;
  /** Contract ID tied to this activation (from the register body). */
  contractId?: string | null;
  /** Human-readable client name resolved from the Client relation (best-effort). */
  customerName?: string | null;
  /** #127 - optional cancellation reason. */
  reason?: string | null;
}

export interface ListTvActivationEventsFilter {
  clientId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
}

export interface TvActivationEvent {
  id: string;
  clientId: string;
  /** Human-readable client name resolved via JOIN on Client (best-effort, may be null). */
  customerName: string | null;
  actorId: string | null;
  actorName: string;
  eventType: TvEventType;
  cic: string | null;
  internalId: string | null;
  seq: number | null;
  contractId: string | null;
  // #127 - optional cancellation reason; null for legacy events.
  reason: string | null;
  createdAt: string; // ISO string
}

export interface TvActivationEventRepository {
  /** Append a new event. Best-effort callers wrap in try/catch. */
  record(input: RecordTvActivationEventInput): Promise<TvActivationEvent>;
  /** List events for a single client, newest first. */
  listByClient(clientId: string): Promise<TvActivationEvent[]>;
  /** List events with optional cross-client filters, newest first. */
  list(filters: ListTvActivationEventsFilter): Promise<TvActivationEvent[]>;
  /** #110 — List events for a contract, newest first. Aditivo, no rompe call-sites existentes. */
  listByContract(contractId: string): Promise<TvActivationEvent[]>;
}
