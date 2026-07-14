import {
  Campaign,
  CampaignRecipient,
  CampaignRecipientStatus,
  CampaignSegment,
  CampaignStatus,
  CampaignVariableSpec,
} from '../entities/campaign';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

/** Datos para crear el header de una campaña (molde `ServiceCutBatchCreate`). */
export interface CampaignCreateData {
  name: string;
  templateRef: string;
  templateName?: string | null;
  segment: CampaignSegment;
  variableSpec: CampaignVariableSpec;
  /** Total de destinatarios YA resuelto (SEG-1..SEG-4) al momento de crear. */
  total: number;
  createdById: string;
}

/** Campos mutables del header durante su corrida (last-write-wins; snapshot completo). */
export interface CampaignPatch {
  status?: CampaignStatus;
  sentCount?: number;
  failedCount?: number;
  skippedCount?: number;
  optedOutCount?: number;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface ListCampaignsQuery extends PaginatedQuery {}

/** Una fila a insertar por `bulkCreateRecipients` — el resto lo completa el repo (id/status/createdAt). */
export interface CampaignRecipientCreateRow {
  clientId: string;
  phoneNormalized: string;
  phoneE164: string;
}

export interface CampaignRecipientPatch {
  status?: CampaignRecipientStatus;
  providerId?: string | null;
  chatwootConversationId?: number | null;
  error?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
}

export interface ListRecipientsFilter extends PaginatedQuery {
  statusIn?: CampaignRecipientStatus[];
}

/** Cursor keyset (orden total `[createdAt, id]`) — `null`/ausente = desde el inicio. */
export interface RecipientKeysetCursor {
  createdAt: string;
  id: string;
}

/**
 * messaging-bulk fix wave 3 (FIX-4-v2) — filtro de paginación KEYSET para el
 * drenaje del envío. `limit` OBLIGATORIO y ACOTADO (memoria O(limit), no
 * O(total)); `after` avanza el cursor sobre el orden total `[createdAt, id]`.
 */
export interface ListRecipientsKeysetFilter {
  statusIn?: CampaignRecipientStatus[];
  /** Tamaño de batch acotado — nunca `total` (evita OOM en campañas de 50-100k). */
  limit: number;
  /** Devuelve SOLO recipients con `(createdAt, id)` ESTRICTAMENTE mayor al cursor. */
  after?: RecipientKeysetCursor;
}

/**
 * messaging-bulk (F2, design §3.7) — molde `ServiceCutBatchRepository` + métodos
 * de recipients. Adapters: `PrismaCampaignRepository` (Batch 7) +
 * `InMemoryCampaignRepository` (Batch 3, tests).
 */
export interface CampaignRepository {
  /** Crea el header en `pending` + persiste `total` (ya resuelto por el caller). */
  create(data: CampaignCreateData): Promise<Campaign>;
  findById(id: string): Promise<Campaign | null>;
  /** Actualiza progreso/estado del header (snapshot completo de los campos provistos). */
  update(id: string, patch: CampaignPatch): Promise<Campaign>;
  list(query: ListCampaignsQuery): Promise<PaginatedResult<Campaign>>;
  /**
   * Crea N `CampaignRecipient` en `queued`, IDEMPOTENTE por `@@unique[campaignId,
   * clientId]` — llamar dos veces con las mismas filas no duplica.
   */
  bulkCreateRecipients(campaignId: string, rows: CampaignRecipientCreateRow[]): Promise<CampaignRecipient[]>;
  /** Patch parcial de UN recipient (status por-fila, SEND-2/SEND-5). */
  updateRecipient(id: string, patch: CampaignRecipientPatch): Promise<CampaignRecipient>;
  /** Paginado — para conteos por-status (`.total`) y páginas de detalle/auditoría (HIST-2). */
  listRecipients(campaignId: string, filter?: ListRecipientsFilter): Promise<PaginatedResult<CampaignRecipient>>;
  /**
   * FIX-4-v2 — drenaje del envío con paginación KEYSET sobre el orden total
   * `[createdAt, id]`. Batch ACOTADO por `filter.limit` (memoria O(limit) en toda
   * la corrida, NO O(total) → sin OOM en campañas grandes). El cursor `after`
   * avanza monótono así que NUNCA revisita antes del cursor → estable ante la
   * mutación del set (recipients saliendo del filtro al pasar a terminal), sin
   * reintroducir el skip del `skip/take`. Reemplaza el fetch-todo de FIX-4.
   */
  listRecipientsKeyset(campaignId: string, filter: ListRecipientsKeysetFilter): Promise<CampaignRecipient[]>;
}
