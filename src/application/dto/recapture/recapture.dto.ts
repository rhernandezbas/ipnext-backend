import { RecaptureLead, RecaptureContact } from '@domain/entities/recaptureLead';
import { RecaptureLeadWithContacts } from '@domain/ports/RecaptureRepository';

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
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface RecaptureLeadDetailDto extends RecaptureLeadDto {
  contacts: RecaptureContactDto[];
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

export function toRecaptureLeadDetailDto(lead: RecaptureLeadWithContacts): RecaptureLeadDetailDto {
  return {
    ...toRecaptureLeadDto(lead),
    contacts: lead.contacts.map(toRecaptureContactDto),
  };
}
