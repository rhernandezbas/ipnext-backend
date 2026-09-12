import type { SuricataBotState } from '@domain/entities/suricataBotState';
import type {
  SuricataMessageAuthorKind,
  SuricataAttachmentStatus,
} from '@domain/entities/suricata';

/**
 * suricata-tickets-mirror (Phase F, tasks F.1/F.2, design D13) — output DTOs
 * for the internal panel's read routes. Never expose raw Prisma rows or
 * domain records directly (repo convention) — these are the explicit wire
 * shapes for `composeSuricataModule`'s `GET` routes.
 */

export interface SuricataAreaDto {
  id: string;
  name: string;
  active: boolean;
}

export interface SuricataTicketListItemDto {
  id: string;
  externalId: string;
  subject: string;
  status: string;
  priority: string | null;
  areaId: string | null;
  areaName: string | null;
  botState: SuricataBotState;
  assigneeId: string | null;
  assigneeName: string | null;
  lastMessageAt: string | null;
  syncedAt: string;
}

export interface ListSuricataTicketsFiltersDto {
  status?: string;
  priority?: string;
  areaId?: string;
  assigneeId?: string;
  botState?: SuricataBotState;
}

export interface ListSuricataTicketsQueryDto extends ListSuricataTicketsFiltersDto {
  page?: number;
  limit?: number;
}

export interface ListSuricataTicketsResultDto {
  data: SuricataTicketListItemDto[];
  total: number;
  page: number;
  limit: number;
}

export interface SuricataMessageDto {
  id: string;
  author: string;
  authorKind: SuricataMessageAuthorKind;
  body: string;
  sentAt: string;
}

export interface SuricataAttachmentDto {
  id: string;
  messageId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  status: SuricataAttachmentStatus;
}

export interface SuricataVerdictDto {
  id: string;
  resuelto: boolean;
  analisis: string;
  motivo: string | null;
  respuestaSugerida: string | null;
  createdAt: string;
  /** D9 — this verdict's `ticketContentHash` no longer matches the ticket's current hash. */
  stale: boolean;
}

/** GET /api/suricata/tickets/:id (UI-2..UI-5) — mirror-only, no live Suricata call. */
export interface SuricataTicketDetailDto {
  id: string;
  externalId: string;
  subject: string;
  status: string;
  priority: string | null;
  areaId: string | null;
  areaName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  externalClientRef: string | null;
  clientId: string | null;
  botState: SuricataBotState;
  assigneeId: string | null;
  assigneeName: string | null;
  openedAt: string | null;
  lastMessageAt: string | null;
  syncedAt: string;
  /** Ordered oldest → newest (Conversation tab timeline, UI-3). */
  messages: SuricataMessageDto[];
  attachments: SuricataAttachmentDto[];
  /** Ordered newest → oldest — `verdicts[0]` is the current one (UI-4). */
  verdicts: SuricataVerdictDto[];
}

/**
 * GET /api/suricata/kpis (UI-6). Percentages are computed over `total`
 * tickets; `staleCount` is reported separately, never folded into the three
 * percentages (D9 — mixing them "no significa nada"). `sincronizadosHoy` is
 * the "count synced today" metric UI-6 asks for.
 */
export interface SuricataKpisDto {
  total: number;
  resueltoBotPct: number;
  requiereHumanoPct: number;
  sinVeredictoPct: number;
  staleCount: number;
  sincronizadosHoy: number;
}
