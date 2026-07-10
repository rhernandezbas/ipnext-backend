import { RecaptureLead, RecaptureContact, RecaptureLeadStatus, RecaptureContactChannel, RecaptureContactOutcome } from '../entities/recaptureLead';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

// ─── Query shapes ─────────────────────────────────────────────────────────────

export interface ListRecaptureLeadsQuery extends PaginatedQuery {
  status?: RecaptureLeadStatus;
  assigneeId?: string;
  /** true = only leads where assigneeId IS NULL */
  unassigned?: boolean;
  /** Filter by origin source */
  source?: 'churned_client' | 'csv';
  /**
   * Restrict to leads whose clientId is in this set (WHERE clientId IN (...)).
   * Used by ListRecaptureLeads to apply the `technology` filter server-side
   * (the use case resolves matching clientIds first, then paginates over them).
   */
  clientIds?: string[];
  /**
   * Filter leads by the DERIVED technology of their client's contracts. Consumed by
   * the ListRecaptureLeads use case, which reads all contracts via
   * ContractRepository.findAllContractTechnologies, derives the effective tech with
   * `deriveTechnology` (the raw column is NULL in prod), and translates the matches
   * into `clientIds`. The repository itself never reads this field (it acts only on
   * `clientIds`).
   */
  technology?: string;
}

// ─── Mutation inputs ──────────────────────────────────────────────────────────

export interface CreateRecaptureLeadData {
  source: 'churned_client' | 'csv';
  clientId?: string | null;
  contactName: string;
  phone?: string | null;
  email?: string | null;
  /** Physical address — from CSV import */
  address?: string | null;
  /** Why the client churned — from CSV import */
  churnReason?: string | null;
  /** Previous plan — from CSV import */
  previousPlan?: string | null;
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
   *
   * `churnReason` (recapture-active-client-match, Decisión 5b) — when provided,
   * seeded from the client's baja contract `motivoBaja` — is written ONLY on the
   * CREATE branch. Idempotent: an already-existing lead is NEVER re-stamped (that
   * lead's `churn_reason` signal coverage comes from reading the contract at
   * match-time instead, not from a backfill here).
   */
  ingestChurned(
    clients: Array<{ id: string; name: string; phone?: string | null; email?: string | null; churnReason?: string | null }>,
  ): Promise<number>;

  /**
   * Unconditional assign: set the lead's assigneeId to `operatorId`.
   * Unlike `claim()`, there is NO guard — overwrites any current assignee.
   *
   * - operatorId non-null → assigneeId=operatorId, claimedAt=now, status='en_gestion'.
   * - operatorId null      → assigneeId=null, claimedAt=null, status='nuevo' (release semantics).
   *
   * Returns the enriched lead (with assigneeName resolved), or null if the lead does not exist.
   */
  assign(leadId: string, operatorId: string | null): Promise<RecaptureLead | null>;
}
