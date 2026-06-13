// Domain entities and enums for the Recaptación module (#80).
// String unions (not Prisma enums) — domain layer has zero external dependencies.

export type RecaptureLeadSource = 'churned_client' | 'csv';

export type RecaptureLeadStatus =
  | 'nuevo'
  | 'en_gestion'
  | 'contactado'
  | 'interesado'
  | 'recuperado'
  | 'descartado';

export type RecaptureContactChannel =
  | 'llamada'
  | 'whatsapp'
  | 'email'
  | 'sms'
  | 'otro';

export type RecaptureContactOutcome =
  | 'sin_respuesta'
  | 'contactado'
  | 'no_interesado'
  | 'interesado'
  | 'recuperado'
  | 'numero_erroneo';

export interface RecaptureLead {
  id: string;
  source: RecaptureLeadSource;
  /** FK to Client — only present when source = 'churned_client' */
  clientId: string | null;
  contactName: string;
  phone: string | null;
  email: string | null;
  status: RecaptureLeadStatus;
  /** FK to RbacUser — null means unassigned */
  assigneeId: string | null;
  claimedAt: string | null; // ISO 8601
  createdAt: string;        // ISO 8601
  updatedAt: string;        // ISO 8601
  /** Physical address of the lead — populated from CSV import */
  address: string | null;
  /** Why the client churned — populated from CSV import */
  churnReason: string | null;
  /** Previous plan the client was on — populated from CSV import */
  previousPlan: string | null;
}

export interface RecaptureContact {
  id: string;
  leadId: string;
  /** FK to RbacUser — quien registró el contacto */
  actorId: string;
  channel: RecaptureContactChannel;
  outcome: RecaptureContactOutcome;
  proposal: string | null;
  note: string | null;
  nextStepAt: string | null; // ISO 8601
  createdAt: string;          // ISO 8601
}
