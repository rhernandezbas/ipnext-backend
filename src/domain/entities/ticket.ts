export type TicketPriority = 'low' | 'medium' | 'high';

// Phase 2: statuses are now dynamic (driven by TicketStatusCatalog table).
// The type is widened from the old 'open' | 'pending' | 'closed' union to string
// so new catalog entries work without code changes.
// The well-known canonical values are still 'open', 'pending', 'closed'.
// The API always exposes status as the catalog name string, never as a DB id.
export type TicketStatus = string;

export interface Ticket {
  id: string;
  sequenceNumber: number;        // #11 — monotonic display number (#N), like tasks
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  customerId: string | null;
  customerName: string | null;   // JOIN-derived (Client.name) — NOT free text
  contractId: string | null;     // FK to Contract (nullable: old tickets have none)
  assigneeId: string | null;
  assigneeName: string | null;   // JOIN-derived (Admin.name)
  // #48 — quien creo el ticket. reporterName es JOIN-derived (RbacUser.name), espejo de assigneeName.
  reporterId: string | null;
  reporterName: string | null;   // JOIN-derived (RbacUser.name)
  areaId: string | null;          // #49 — FK to TicketAreaCatalog
  areaName: string | null;        // #49 — JOIN-derived (TicketAreaCatalog.name)
  areaColor: string | null;       // #69 — JOIN-derived (TicketAreaCatalog.color), for the area pill
  grCasoId: string | null;
  // #84 — set when the ticket transitions to a closed status; null while open/pending.
  resolvedAt: string | null;     // ISO 8601
  // #85 — set when the ticket is archived (must be closed first); null otherwise.
  archivedAt: string | null;     // ISO 8601
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
  // #44 (D7) — related tasks, enriched via PrismaTicketRepository.getById include.
  // Optional so existing fixtures/tests that don't set it keep compiling.
  tasks?: Array<{ id: string; sequenceNumber: number; title: string }>;
  // v2.B (portal-ticket-messaging) — cursor de lectura por lado ("no leídos").
  // Optional (no `| null` obligatorio) por la misma razón que `tasks`: los
  // fixtures/tests existentes que construyen un Ticket a mano no deben romperse.
  // Ausente/undefined se trata igual que null ("nunca leyó el hilo").
  clientMessagesReadAt?: string | null;
  staffMessagesReadAt?: string | null;
}

export interface TicketStats {
  totalOpen: number;
  totalPending: number;
  totalClosed: number;
  byPriority: { low: number; medium: number; high: number };
}
