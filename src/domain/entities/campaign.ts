/**
 * messaging-bulk (F2) — Campaign / CampaignRecipient domain entities.
 *
 * Molde `ServiceCutBatch` (domain/entities/serviceCutBatch.ts): header + contadores
 * persistidos, progreso por-fila auditable/resumible. Plain domain shapes — el
 * adapter Prisma (`PrismaCampaignRepository`, Batch 7) mapea desde/hacia el modelo
 * de `prisma/schema.prisma`; el dominio NUNCA importa Prisma (DIP estricto).
 */

export type CampaignStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';

/**
 * `opted_out` en snake_case (mismo vocabulario que el enum Prisma — Prisma no
 * admite guiones en valores de enum). El DTO de wire (application/dto) lo
 * traduce a `'opted-out'` para el display (design §1.2).
 */
export type CampaignRecipientStatus = 'queued' | 'sent' | 'delivered' | 'opted_out' | 'skipped' | 'failed';

/** Filtro de segmentación serializado tal cual para auditoría (CAMP-1). */
export interface CampaignSegment {
  statuses: string[];
  balanceMin?: number;
  balanceMax?: number;
}

/** v1 whitelist de fuentes para resolver una variable del template (design §3.3). */
export type CampaignVariableSource = 'name' | 'balanceDue' | 'literal';

export interface CampaignVariableSpecEntry {
  source: CampaignVariableSource;
  /** Requerido cuando `source === 'literal'`; ignorado para 'name'/'balanceDue'. */
  value?: string;
}

/**
 * Mapea cada variable del template (índice `"1"`/`"2"` o nombre declarado) a
 * cómo se resuelve POR-DESTINATARIO en `SendCampaign` (Batch 4). Ver tasks.md
 * contradicción #3: es el MISMO campo que el spec llama `variablesMap` —
 * CAMP-3 valida presencia de KEYS contra esta estructura, no que los VALUES
 * sean literales fijos.
 */
export type CampaignVariableSpec = Record<string, CampaignVariableSpecEntry>;

export interface Campaign {
  id: string;
  name: string;
  /** ContentSid de Twilio (HX…) — enviable. */
  templateRef: string;
  templateName: string | null;
  segment: CampaignSegment;
  variableSpec: CampaignVariableSpec;
  status: CampaignStatus;
  total: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  optedOutCount: number;
  createdById: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CampaignRecipient {
  id: string;
  campaignId: string;
  clientId: string;
  /** Clave de de-dup (`normalizePhone` verbatim) — auditable. */
  phoneNormalized: string;
  /** Destino REAL enviado (`toWhatsAppE164`) — auditable. */
  phoneE164: string;
  status: CampaignRecipientStatus;
  /** SM… de Twilio cuando `status === 'sent'`. */
  providerId: string | null;
  /** Link al mirror F1 si el cliente responde (F3/opcional). */
  chatwootConversationId: number | null;
  /** Motivo del fallo por-fila, SANEADO (HIST-3 — nunca el payload crudo del proveedor). */
  error: string | null;
  sentAt: string | null;
  /** Recién se llena en F3 (status callback Twilio). */
  deliveredAt: string | null;
  createdAt: string;
}
