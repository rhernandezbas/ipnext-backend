import { RecaptureLead, RecaptureContact, RecaptureLeadStatus, RecaptureContactChannel, RecaptureContactOutcome } from '../entities/recaptureLead';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

// ─── Query shapes ─────────────────────────────────────────────────────────────

export interface ListRecaptureLeadsQuery extends PaginatedQuery {
  status?: RecaptureLeadStatus;
  assigneeId?: string;
  /** true = only leads where assigneeId IS NULL */
  unassigned?: boolean;
}

// ─── Mutation inputs ──────────────────────────────────────────────────────────

export interface CreateRecaptureLeadData {
  source: 'churned_client' | 'csv';
  clientId?: string | null;
  contactName: string;
  phone?: string | null;
  email?: string | null;
}

export interface AddContactData {
  leadId: string;
  actorId: string;
  channel: RecaptureContactChannel;
  outcome: RecaptureContactOutcome;
  proposal?: string | null;
  note?: string | null;
  nextStepAt?: string | null;
  /** Optional: if set, the lead's status will be updated to this value */
  advanceStatus?: RecaptureLeadStatus;
}

/** Lead with its contact timeline — used by GetRecaptureLead */
export interface RecaptureLeadWithContacts extends RecaptureLead {
  contacts: RecaptureContact[];
}

// ─── Port interface ───────────────────────────────────────────────────────────

export interface RecaptureRepository {
  /** List leads with optional filters and pagination. */
  list(query: ListRecaptureLeadsQuery): Promise<PaginatedResult<RecaptureLead>>;

  /** Get a single lead with its contacts. Returns null if not found. */
  getById(id: string): Promise<RecaptureLeadWithContacts | null>;

  /** Create a new lead. */
  create(data: CreateRecaptureLeadData): Promise<RecaptureLead>;

  /**
   * Atomic claim: assign the lead to `actorId` only when `assigneeId IS NULL`.
   * Returns the updated lead, or null if it was already claimed.
   * Also sets status to 'en_gestion' and stamps claimedAt.
   */
  claim(leadId: string, actorId: string): Promise<RecaptureLead | null>;

  /**
   * Atomic claim-next: select the oldest lead with status='nuevo' and
   * assigneeId IS NULL, then claim it for `actorId`.
   * Returns the claimed lead, or null if no free leads remain.
   */
  claimNext(actorId: string): Promise<RecaptureLead | null>;

  /**
   * Release: clear assigneeId and claimedAt, reset status to 'nuevo'.
   * Returns the updated lead, or null if the lead does not exist.
   */
  release(leadId: string): Promise<RecaptureLead | null>;

  /**
   * Update the lead status.
   * Returns the updated lead, or null if the lead does not exist.
   */
  updateStatus(leadId: string, status: RecaptureLeadStatus): Promise<RecaptureLead | null>;

  /**
   * Append a contact entry to a lead.
   * Optionally advances the lead's status when `data.advanceStatus` is provided.
   * Returns the new contact.
   */
  addContact(data: AddContactData): Promise<RecaptureContact>;

  /**
   * Ingest churned clients: for every Client where status = 'baja',
   * create a RecaptureLead (source='churned_client') if one does not already
   * exist (idempotent via partial unique index on clientId WHERE source='churned_client').
   * Returns the number of new leads created.
   */
  ingestChurned(clients: Array<{ id: string; name: string; phone?: string | null; email?: string | null }>): Promise<number>;
}
