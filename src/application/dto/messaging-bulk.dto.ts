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

export interface PreviewSegmentInput {
  statuses: string[];
  balanceMin?: number;
  balanceMax?: number;
  /**
   * manual-recipients (MAN-5) — lista manual OPCIONAL, PARALELA al filtro del
   * segmento (NO parte de él). Cuando se pasa, `count` refleja la UNIÓN
   * (segmento ∪ manuales) deduplicada por `clientId`, sin doble-contar el overlap.
   */
  manualClientIds?: string[];
}

export interface PreviewSegmentSampleItemDto {
  clientId: string;
  name: string;
  phoneE164: string;
  /** messaging-bulk v1.1 (preview modal) — estado del cliente (`ResolvedRecipient.status`). */
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
}

// ─── Paginado de destinatarios resueltos (messaging-bulk v1.1, ListSegmentRecipients) ──

/**
 * v1.1 — input de `ListSegmentRecipients`: el MISMO segmento que
 * `PreviewSegmentInput` + paginado. El segmento NO está persistido: cada
 * llamada re-resuelve `listSegmentRecipients` y pagina el set YA resuelto
 * (post opt-out/dedup/teléfono-inválido) en memoria — no hay una tabla que
 * pagine del lado de la DB.
 */
export interface ListSegmentRecipientsInput extends PreviewSegmentInput, PaginatedQuery {}

/** v1.1 — un destinatario RESUELTO (receptor real), una página de este listado. */
export interface SegmentRecipientItemDto {
  clientId: string;
  name: string;
  phoneE164: string;
  status: string;
}

/**
 * v1.1 — igual que `PaginatedResult<SegmentRecipientItemDto>` + los mismos
 * `skipped`/`statusCounts` que expone el preview (SEG-1..SEG-5), para que el
 * modal no tenga que combinar dos respuestas distintas.
 */
export interface ListSegmentRecipientsOutput extends PaginatedResult<SegmentRecipientItemDto> {
  skipped: {
    optedOut: number;
    duplicatePhone: number;
    invalidPhone: number;
  };
  statusCounts: Record<string, number>;
}

// ─── Creación de campaña (CAMP-1..CAMP-4) ────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  /** ContentSid Twilio (HX…). */
  templateRef: string;
  templateName?: string;
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
  createdById: string;
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
  clientId: string;
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
    phoneE164: recipient.phoneE164,
    status: toRecipientStatusDto(recipient.status),
    error: recipient.error,
    sentAt: recipient.sentAt,
  };
}
