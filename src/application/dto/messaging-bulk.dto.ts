/**
 * messaging-bulk (F2) — DTOs curados para templates/segmentación/campañas.
 * Co-located con `messaging.ts` (DTOs de messaging-inbox F1) por convención del
 * repo, pero en archivo separado (T2.1) — capability distinta.
 *
 * Regla dura (HIST-3): el detalle por-destinatario NUNCA expone el
 * payload/response crudo del proveedor ni credenciales — solo `error` saneado.
 *
 * Nota de nombres (tasks.md contradicción #1): donde design.md y spec.md usan
 * nombres distintos para el MISMO dato, estos DTOs usan los nombres del SPEC
 * (`sdd-verify` valida contra el spec) — `count`/`skipped.*` en vez de
 * `total`/`excluded*`/`dedupCollapsed`, y `variablesMap` en vez de
 * `variableSpec` en la superficie de entrada de `CreateCampaign`.
 */
import type {
  Campaign,
  CampaignRecipient,
  CampaignSegment,
  CampaignVariableSpec,
} from '@domain/entities/campaign';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { PaginatedQuery, PaginatedResult } from './pagination';

// ─── Templates (TPL-1/TPL-2) ─────────────────────────────────────────────────

export type TemplateApprovalStatus = TemplateDto['approvalStatus'];

export interface TemplateSummaryDto {
  contentSid: string;
  friendlyName: string;
  language: string;
  /** Nombres de variable declarados por el template (keys de `TemplateDto.variables`). */
  variables: string[];
  approvalStatus: TemplateApprovalStatus;
  category?: string;
  /** `true` solo si `approvalStatus === 'approved'` (TPL-1). */
  sendable: boolean;
  /**
   * messaging-bulk v1.1 (preview modal) — texto plano del template, tal cual
   * `TemplateDto.body` (ver ese doc). `''` cuando el proveedor no declaró un
   * body de texto plano para este template.
   */
  body: string;
}

// ─── Segmentación — preview/conteo (SEG-1..SEG-5) ────────────────────────────

/**
 * bulk-csv-recipients (CSV-1) — un contacto crudo del CSV, PARALELO a `segment` y
 * `manualClientIds` (mismo patrón que MAN-5). El BE es la AUTORIDAD de validación
 * (D9): el FE solo filtra estructura/filas obviamente vacías, acá se valida
 * `toWhatsAppE164` + se resuelve el vínculo por teléfono (D3).
 */
export interface ManualContactDto {
  name: string;
  phone: string;
  /**
   * external-bulk-messaging (D4.c/D4.e) — literales POR-RECIPIENT del caller
   * externo (`SendExternalBulk`). Ausente en TODO caller de la UI admin/CSV
   * humano (comportamiento actual intacto). Pisa `variablesMap` GLOBAL por key
   * en `SendCampaign` (SEND-10), NUNCA acá.
   */
  variables?: Record<string, string>;
}

export interface PreviewSegmentInput {
  statuses: string[];
  balanceMin?: number;
  balanceMax?: number;
  /**
   * node-segment — filtro por nodo (`NetworkSite.id`). Ausente/null/'' = sin
   * filtro. Un cliente entra si tiene ≥1 contrato cuyo `networkSiteId` matchea;
   * es AND con statuses/deuda. Nodo o AP SOLOS ya son un segmento válido (no
   * exigen statuses/deuda) — el caso "aviso de corte a todos los del nodo X".
   */
  networkSiteId?: string | null;
  /**
   * node-segment — filtro por AP (`AccessPoint.id`), con o sin `networkSiteId`.
   * Si vienen ambos, deben matchear en EL MISMO contrato. Ausente/null/'' = sin
   * filtro.
   */
  accessPointId?: string | null;
  /**
   * manual-recipients (MAN-5) — lista manual OPCIONAL, PARALELA al filtro del
   * segmento (NO parte de él). Cuando se pasa, `count` refleja la UNIÓN
   * (segmento ∪ manuales) deduplicada por `clientId`, sin doble-contar el overlap.
   */
  manualClientIds?: string[];
  /**
   * bulk-csv-recipients (CSV-1) — 4to dominio, PARALELO a `segment` y
   * `manualClientIds`. `count` refleja la unión de las 3 fuentes.
   */
  manualContacts?: ManualContactDto[];
  /**
   * bulk-task-recipients (TASK-1) — 5to dominio, PARALELO a `segment`/
   * `manualClientIds`/`manualContacts`: clientes con ≥1 tarea ABIERTA en un
   * `Stage` mapeado (`messaging-task-stage-config`). `count` refleja la unión
   * de las 4 fuentes. A diferencia de `manualContacts`, SÍ viaja por query en
   * los deep-links GET (D5 — es una lista corta de ids de catálogo, como
   * `statuses`, no un payload arbitrario).
   */
  taskStageIds?: string[];
}

export interface PreviewSegmentSampleItemDto {
  /**
   * bulk-csv-recipients (D11) — `null` para un contacto CSV crudo (sin `Client`
   * vinculado). El FE del PreviewModal pasa a keyear filas con `clientId ??
   * phoneE164`.
   */
  clientId: string | null;
  name: string;
  phoneE164: string;
  /** messaging-bulk v1.1 (preview modal) — estado del cliente (`ResolvedRecipient.status`). `'no_cliente'` para un crudo. */
  status: string;
}

export interface PreviewSegmentOutput {
  /** Nombre del spec (SEG-1..SEG-4) — NO `total` (nombre de design). */
  count: number;
  /** Muestra acotada (ej. 20), determinística — gana el `id` menor en un empate de de-dup. */
  sample: PreviewSegmentSampleItemDto[];
  skipped: {
    /** SEG-2 — excluidos por `whatsappOptOutAt != null`. */
    optedOut: number;
    /** SEG-3 — colapsados por de-dup de `normalizePhone`. */
    duplicatePhone: number;
    /** SEG-4 — `toWhatsAppE164` devolvió `null` (teléfono ausente/basura). */
    invalidPhone: number;
  };
  /**
   * messaging-bulk v1.1 (preview modal) — conteo de RECEPTORES (el set
   * `resolved`, post opt-out/dedup/teléfono-inválido) agrupados por
   * `status` del cliente. Ej. `{active:120, late:900}`.
   */
  statusCounts: Record<string, number>;
  /**
   * bulk-task-recipients (TASK-3, TASK-7) — chip agregado: tareas ABIERTAS en
   * los `taskStageIds` pedidos que NO tienen `customerId` (tareas de red,
   * `kind:'network'`) — NUNCA un drop silencioso. `0` cuando `taskStageIds`
   * está vacío/ausente. OPCIONAL en este batch (B4): el resolver que lo
   * calcula se wirea en B5 — todo caller real siempre lo expone.
   */
  noCustomerCount?: number;
  /**
   * bulk-task-stage-transition (TRANS-6) — cuántas TAREAS transicionarán de estado
   * al enviar (recipients `source:'task'` con un estado resultante configurado). `0`
   * si no hay destino global configurado o no hay dominio tarea. El FE lo usa para el
   * hint "N tareas pasarán a <estado>".
   */
  taskWillTransitionCount?: number;
}

// ─── Paginado de destinatarios resueltos (messaging-bulk v1.1, ListSegmentRecipients) ──

/** bulk-csv-recipients (D11) — qué vista pagina el endpoint (`recipients` = default, backcompat). */
export type SegmentRecipientsView = 'recipients' | 'excluded';

/**
 * v1.1 — input de `ListSegmentRecipients`: el MISMO segmento que
 * `PreviewSegmentInput` + paginado. El segmento NO está persistido: cada
 * llamada re-resuelve `listSegmentRecipients` y pagina el set YA resuelto
 * (post opt-out/dedup/teléfono-inválido) en memoria — no hay una tabla que
 * pagine del lado de la DB.
 *
 * bulk-csv-recipients (DET-1/DET-2) — hereda `manualContacts` de
 * `PreviewSegmentInput` (cierra la deuda F4 documentada en el propio FE) + `view`
 * para elegir entre la página de destinatarios o la de excluidos con detalle.
 */
export interface ListSegmentRecipientsInput extends PreviewSegmentInput, PaginatedQuery {
  view?: SegmentRecipientsView;
}

/** v1.1 — un destinatario RESUELTO (receptor real), una página de este listado. */
export interface SegmentRecipientItemDto {
  /** bulk-csv-recipients (D11) — `null` para un contacto CSV crudo (sin `Client`). */
  clientId: string | null;
  name: string;
  phoneE164: string;
  status: string;
  /**
   * bulk-csv-recipients (DET-1) — de qué fuente vino ESTE destinatario
   * resuelto. bulk-task-recipients agrega `'task'` (5to dominio, precedencia
   * MENOR — solo se muestra si el destinatario NO vino de otra fuente).
   */
  source: 'segment' | 'manual' | 'csv' | 'task';
}

/**
 * bulk-csv-recipients (DET-2) — un excluido con el motivo, paginado. `clientId`/
 * `status` solo presentes cuando el excluido SÍ vinculó a un `Client` (opt-out o
 * duplicado de un vinculado) — un `sin_nombre`/`sin_telefono`/`telefono_invalido`
 * de un contacto crudo nunca resuelve `Client`.
 */
export interface ExcludedRecipientItemDto {
  name: string;
  phone: string;
  reason: 'sin_nombre' | 'sin_telefono' | 'telefono_invalido' | 'opt_out' | 'duplicado';
  /** bulk-task-recipients agrega `'task'` (5to dominio, molde DET-1). */
  source: 'segment' | 'manual' | 'csv' | 'task';
  clientId?: string;
  status?: string;
}

/**
 * v1.1 — igual que `PaginatedResult<SegmentRecipientItemDto>` + los mismos
 * `skipped`/`statusCounts` que expone el preview (SEG-1..SEG-5), para que el
 * modal no tenga que combinar dos respuestas distintas.
 *
 * bulk-csv-recipients (DET-2) — con `view:'excluded'`, `data` es
 * `ExcludedRecipientItemDto[]` en su lugar (unión discriminada por el `view` del
 * input, NO por el shape de la respuesta — el caller ya sabe qué pidió).
 */
export interface ListSegmentRecipientsOutput extends PaginatedResult<SegmentRecipientItemDto | ExcludedRecipientItemDto> {
  skipped: {
    optedOut: number;
    duplicatePhone: number;
    invalidPhone: number;
  };
  statusCounts: Record<string, number>;
  /** bulk-task-recipients (TASK-3, TASK-7) — ver `PreviewSegmentOutput`. */
  noCustomerCount?: number;
}

// ─── Creación de campaña (CAMP-1..CAMP-4) ────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  /** ContentSid Twilio (HX…). */
  templateRef: string;
  templateName?: string;
  /**
   * campaign-chatwoot-label (CLBL-6) — `title` de un label REAL de Chatwoot
   * elegido OPCIONALMENTE al crear. Pass-through puro (Decisión D): CERO
   * validación/re-consulta contra el catálogo acá — se persiste tal cual.
   * Ausente/`undefined` → `Campaign.chatwootLabel` queda `null`.
   */
  chatwootLabel?: string;
  segment: CampaignSegment;
  /**
   * Nombre del spec (CAMP-1/CAMP-3). Mismo campo que `CampaignVariableSpec` del
   * dominio — CAMP-3 valida presencia de KEYS contra `TemplateDto.variables`,
   * preservando `{source, value?}` por key (tasks.md contradicción #3, NO un
   * mapa de valores fijos).
   */
  variablesMap: CampaignVariableSpec;
  /**
   * manual-recipients (MAN-1) — lista manual OPCIONAL de clientes, PARALELA al
   * `segment` (NO dentro de `CampaignSegment`, que es el filtro serializado/
   * auditable). Los destinatarios finales = UNIÓN de (segmento resuelto, si hay
   * criterio) ∪ (estos clientes), deduplicada por `clientId`. Ids inexistentes →
   * fail-loud (`ManualRecipientsNotFoundError`, MAN-3).
   */
  manualClientIds?: string[];
  /**
   * bulk-csv-recipients (CSV-1) — 4to dominio de destinatarios, PARALELO a
   * `segment`/`manualClientIds`, combinable con cualquiera de los dos (o ambos).
   * Cada contacto válido se vincula por teléfono a un `Client` existente
   * (CSV-2) o se persiste crudo (`clientId: null`, CSV-3).
   */
  manualContacts?: ManualContactDto[];
  /**
   * bulk-task-recipients (TASK-1) — 5to dominio de destinatarios, PARALELO a
   * `segment`/`manualClientIds`/`manualContacts`, combinable con cualquiera de
   * los otros 3. Cada `stageId` DEBE estar mapeado como elegible
   * (`messaging-task-stage-config`) — el use case valida ANTES de resolver
   * clientes (TASK-2, `assertTaskStagesEligible`), 422 si no.
   */
  taskStageIds?: string[];
  /**
   * bulk-granular-perms — acciones `messaging` que el usuario TIENE (`bulk_active`,
   * `bulk_blocked`, `bulk_numbers`, …), o `['*']`/`Set(['*'])` para super_admin.
   * La RUTA las resuelve (vía `rbacUserRepo`) y las pasa; el use case BLOQUEA la
   * campaña si falta permiso para algún estado/tipo presente en los destinatarios.
   * OPCIONAL: `undefined` → sin enforcement (backcompat de tests/callers directos;
   * la ruta SIEMPRE lo pasa en prod, que es el borde de seguridad real).
   */
  allowedBulkActions?: Set<string> | string[];
  createdById: string;
  /**
   * external-bulk-messaging (D1.a) — presente SOLO cuando `SendExternalBulk`
   * crea la campaña (`api-messaging`). Ausente/`undefined` → `Campaign.
   * externalIdempotencyKey` persiste `null` (UI admin, comportamiento actual).
   */
  externalIdempotencyKey?: string | null;
}

export interface CreateCampaignOutput {
  campaignId: string;
  total: number;
  status: 'pending';
}

// ─── Historial (HIST-1/HIST-2/HIST-3) ────────────────────────────────────────

export type CampaignStatusDto = Campaign['status'];

/** `opted_out` (Prisma, sin guiones) → `'opted-out'` en el wire (design §1.2). */
export type CampaignRecipientStatusDto = 'queued' | 'sent' | 'delivered' | 'opted-out' | 'skipped' | 'failed';

export interface CampaignSummaryDto {
  id: string;
  name: string;
  templateName: string | null;
  status: CampaignStatusDto;
  total: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  optedOutCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Detalle (GetCampaign) — header completo + el filtro serializado (auditoría, CAMP-1). */
export interface CampaignDto extends CampaignSummaryDto {
  templateRef: string;
  segment: CampaignSegment;
}

export interface CampaignRecipientDto {
  id: string;
  /** bulk-csv-recipients (PER-3) — `null` para un recipient crudo (sin `Client`, CSV-3). */
  clientId: string | null;
  /** bulk-csv-recipients (PER-3) — nombre del CSV, solo presente en filas `clientId: null`. */
  contactName: string | null;
  phoneE164: string;
  status: CampaignRecipientStatusDto;
  /** HIST-3 — SANEADO, nunca el payload/response crudo del proveedor ni credenciales. */
  error: string | null;
  sentAt: string | null;
}

// ─── Mappers (puros, sobre las entities de dominio) ──────────────────────────

function toRecipientStatusDto(status: CampaignRecipient['status']): CampaignRecipientStatusDto {
  return status === 'opted_out' ? 'opted-out' : status;
}

export function toCampaignSummaryDto(campaign: Campaign): CampaignSummaryDto {
  return {
    id: campaign.id,
    name: campaign.name,
    templateName: campaign.templateName,
    status: campaign.status,
    total: campaign.total,
    sentCount: campaign.sentCount,
    failedCount: campaign.failedCount,
    skippedCount: campaign.skippedCount,
    optedOutCount: campaign.optedOutCount,
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt,
    finishedAt: campaign.finishedAt,
  };
}

export function toCampaignDto(campaign: Campaign): CampaignDto {
  return {
    ...toCampaignSummaryDto(campaign),
    templateRef: campaign.templateRef,
    segment: campaign.segment,
  };
}

/**
 * HIST-3 — `error` ya debe llegar saneado desde el use case (nunca el objeto
 * crudo del proveedor); este mapper solo proyecta los campos curados del wire.
 */
export function toCampaignRecipientDto(recipient: CampaignRecipient): CampaignRecipientDto {
  return {
    id: recipient.id,
    clientId: recipient.clientId,
    contactName: recipient.contactName,
    phoneE164: recipient.phoneE164,
    status: toRecipientStatusDto(recipient.status),
    error: recipient.error,
    sentAt: recipient.sentAt,
  };
}
