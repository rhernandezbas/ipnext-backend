import { RecaptureLead, RecaptureContact } from '@domain/entities/recaptureLead';
import { RecaptureLeadWithContacts } from '@domain/ports/RecaptureRepository';
import type {
  ActiveMatchSignal,
  MatchedClientSummary,
} from '@application/use-cases/recapture/matchActiveClient';

// Re-exported here so FE-facing DTO consumers don't need to reach into the
// use-case module for the Wire Contract types (tasks.md §3.1).
export type { ActiveMatchSignal, MatchedClientSummary };

// ─── Lead DTO ────────────────────────────────────────────────────────────────

export interface RecaptureLeadDto {
  id: string;
  source: string;
  clientId: string | null;
  contactName: string;
  phone: string | null;
  email: string | null;
  status: string;
  assigneeId: string | null;
  /** Display name of the assignee — null when unassigned. Resolved by the Prisma adapter via JOIN. */
  assigneeName: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Lead LIST-item DTO ──────────────────────────────────────────────────────
// technologies lives ONLY here, not on the base DTO: it is enrichment that only
// the listing (ListRecaptureLeads) computes. Detail / update / assign return the
// base RecaptureLeadDto, which never carries technologies (no empty-[] lie).

export interface RecaptureLeadListItemDto extends RecaptureLeadDto {
  /**
   * DISTINCT technologies of the lead's client contracts (catalog values:
   * Fiber/FTTH/Wireless/DOCSIS/HFC/Radio). `[]` when no clientId or no technologies.
   */
  technologies: string[];
  /**
   * recapture-active-client-match — "posible cliente activo" detector.
   * Deduplicated union of signals across every active client matched (design.md
   * Decisión 4: list gets ONLY the signal list, the rich match lives on detail).
   * `[]` = no match, AND the fail-open value if the enrichment errors (design.md
   * Decisión 3 — this badge is secondary, it must never break the list).
   */
  possibleActiveMatchSignals: ActiveMatchSignal[];
}

// ─── Contact DTO ─────────────────────────────────────────────────────────────

export interface RecaptureContactDto {
  id: string;
  leadId: string;
  actorId: string;
  channel: string;
  outcome: string;
  proposal: string | null;
  note: string | null;
  nextStepAt: string | null;
  createdAt: string;
}

// ─── Lead detail DTO (with contacts timeline) ────────────────────────────────

/**
 * recapture-active-client-match — rich match result for the detail view.
 * `signals` is the same deduplicated union as the list's `possibleActiveMatchSignals`;
 * `matchedClients` carries one entry PER matched active client (array — spec.md
 * "Cardinalidad", NOT a singular). `'churn_reason'` can live in `signals` without
 * any corresponding `matchedClients[]` entry (it is a property of the lead, not
 * of a client — spec.md).
 */
export interface PossibleActiveMatch {
  signals: ActiveMatchSignal[];
  matchedClients: MatchedClientSummary[];
}

export interface RecaptureLeadDetailDto extends RecaptureLeadDto {
  contacts: RecaptureContactDto[];
  possibleActiveMatch: PossibleActiveMatch;
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

export function toRecaptureLeadDto(lead: RecaptureLead): RecaptureLeadDto {
  return {
    id: lead.id,
    source: lead.source,
    clientId: lead.clientId,
    contactName: lead.contactName,
    phone: lead.phone,
    email: lead.email,
    status: lead.status,
    assigneeId: lead.assigneeId,
    assigneeName: lead.assigneeName,
    claimedAt: lead.claimedAt,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

export function toRecaptureContactDto(contact: RecaptureContact): RecaptureContactDto {
  return {
    id: contact.id,
    leadId: contact.leadId,
    actorId: contact.actorId,
    channel: contact.channel,
    outcome: contact.outcome,
    proposal: contact.proposal,
    note: contact.note,
    nextStepAt: contact.nextStepAt,
    createdAt: contact.createdAt,
  };
}

/**
 * Returns the detail DTO shape MINUS `possibleActiveMatch` — that field is
 * assembled by `GetRecaptureLead` (needs `CustomerRepository`, a dependency this
 * pure mapper does not have), not by this function. Same split precedent as
 * `technologies` on `RecaptureLeadListItemDto` (mapper stays a pure fn of the domain entity).
 */
export function toRecaptureLeadDetailDto(
  lead: RecaptureLeadWithContacts,
): Omit<RecaptureLeadDetailDto, 'possibleActiveMatch'> {
  return {
    ...toRecaptureLeadDto(lead),
    contacts: lead.contacts.map(toRecaptureContactDto),
  };
}
