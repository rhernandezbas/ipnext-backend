import {
  Campaign,
  CampaignRecipient,
  CampaignRecipientStatus,
  CampaignSegment,
  CampaignStatus,
  CampaignVariableSpec,
} from '../entities/campaign';
import { PaginatedResult, PaginatedQuery } from '../entities/pagination';

/** Datos para crear el header de una campaña (molde `ServiceCutBatchCreate`). */
export interface CampaignCreateData {
  name: string;
  templateRef: string;
  templateName?: string | null;
  /** messaging-bulk-inbox (F1) — body de texto del template capturado en CreateCampaign. */
  templateBody?: string | null;
  /**
   * campaign-chatwoot-label (CLBL-6) — `title` del label REAL de Chatwoot
   * elegido opcionalmente al crear. Pass-through: se persiste tal cual, sin
   * re-consultar el catálogo (Decisión D). Ausente/`null` → `null`.
   */
  chatwootLabel?: string | null;
  segment: CampaignSegment;
  variableSpec: CampaignVariableSpec;
  /** Total de destinatarios YA resuelto (SEG-1..SEG-4) al momento de crear. */
  total: number;
  /**
   * bulk-granular-perms — estados de cliente presentes en la unión resuelta
   * (distinct, sin los números crudos) + si hubo números crudos. Poblados por
   * `CreateCampaign` para el re-chequeo de permisos en el envío. Opcionales para
   * no romper fixtures de tests ya verdes (default `[]`/`false`).
   */
  recipientStatuses?: string[];
  hasRawRecipients?: boolean;
  createdById: string;
  /**
   * external-bulk-messaging (D1.a) — presente SOLO en campañas creadas por
   * `SendExternalBulk` (`api-messaging`). Ausente/`undefined` → persiste
   * `null` (UI admin, comportamiento actual sin cambios).
   */
  externalIdempotencyKey?: string | null;
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
  /** bulk-csv-recipients (PER-1/PER-2) — `null` para una fila contact (CSV-3). */
  clientId: string | null;
  /** bulk-csv-recipients (PER-2) — nombre del CSV; solo tiene sentido cuando `clientId` es `null`. */
  contactName?: string | null;
  phoneNormalized: string;
  phoneE164: string;
  /** bulk-task-stage-transition — snapshots per-tarea (solo filas source:'task'). */
  taskId?: string | null;
  taskFromStageId?: string | null;
  taskResultingStageId?: string | null;
  /**
   * external-bulk-messaging (D4.c) — literales POR-RECIPIENT del caller
   * externo. Ausente/`undefined` → persiste `null` (aditivo, resto de
   * dominios no lo usan). Persistencia SOLO en B1.
   */
  variables?: Record<string, string> | null;
}

export interface CampaignRecipientPatch {
  status?: CampaignRecipientStatus;
  providerId?: string | null;
  chatwootConversationId?: number | null;
  /** messaging-bulk-inbox (F1) — lazo al mirror local seteado por la proyección al inbox. */
  conversationId?: string | null;
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
 * Change 3 (templates CRUD) — lookup NARROW (ISP) para el guard de borrado de
 * templates: "¿hay campañas ACTIVAS (pending/running) usando este `templateRef`?".
 * Segregado de `CampaignRepository` a propósito: `DeleteTemplate` depende SOLO de
 * esto (no del repo completo), y NO se fuerza a los wrappers de test que
 * implementan `CampaignRepository` a implementar un método que no usan.
 * `PrismaCampaignRepository` e `InMemoryCampaignRepository` implementan AMBAS.
 */
export interface ActiveCampaignLookup {
  /** Campañas con status ∈ {pending, running} cuyo `templateRef === contentSid`. */
  listActiveByTemplateRef(templateRef: string): Promise<Campaign[]>;
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
  /** external-bulk-messaging (D3, GUARD-0) — lookup por la key dedicada del caller M2M; `null` = key nunca usada. */
  findByExternalIdempotencyKey(key: string): Promise<Campaign | null>;
  /**
   * external-bulk-messaging (D3.a/D6, REVISADO por el fix wave F1 — finding F2)
   * — cupo diario: cuenta los `CampaignRecipient` AUTORIZADOS desde `since`
   * (`createdAt >= since`, INCLUSIVO) de campañas creadas por `createdById`,
   * excluyendo `skipped`/`opted_out` (a esos nunca se les autorizó un mensaje).
   *
   * Contar `status:'sent'` (la versión original) hacía el cupo INEXIGIBLE: el
   * envío real corre asincrónico detrás del `CampaignRunner`, así que entre el
   * `send` que autoriza N destinatarios y el momento en que salen, la cuenta
   * devuelve ~0 y el siguiente lote pasa igual — N lotes concurrentes
   * multiplican el tope. Contando lo CREADO, cada intento autorizado quema cupo
   * en el instante en que la `Campaign` nace, que es cuando el compromiso de
   * gasto ya está tomado.
   */
  countAuthorizedRecipientsByCreatorSince(createdById: string, since: Date): Promise<number>;
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
