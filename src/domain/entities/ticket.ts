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
  assigneeId: string | null;
  assigneeName: string | null;   // JOIN-derived (Admin.name)
  // #48 — quien creo el ticket. reporterName es JOIN-derived (RbacUser.name), espejo de assigneeName.
  reporterId: string | null;
  reporterName: string | null;   // JOIN-derived (RbacUser.name)
  areaId: string | null;          // #49 — FK to TicketAreaCatalog
  areaName: string | null;        // #49 — JOIN-derived (TicketAreaCatalog.name)
  areaColor: string | null;       // #69 — JOIN-derived (TicketAreaCatalog.color), for the area pill
  grCasoId: string | null;
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
  // #44 (D7) — related tasks, enriched via PrismaTicketRepository.getById include.
  // Optional so existing fixtures/tests that don't set it keep compiling.
  tasks?: Array<{ id: string; sequenceNumber: number; title: string }>;
}

export interface TicketStats {
  totalOpen: number;
  totalPending: number;
  totalClosed: number;
  byPriority: { low: number; medium: number; high: number };
}
