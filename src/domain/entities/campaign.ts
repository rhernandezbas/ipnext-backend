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
  /**
   * node-segment — filtro por nodo (`NetworkSite.id`). Ausente/null/'' = sin
   * filtro. Un cliente entra si tiene ≥1 contrato cuyo `networkSiteId` matchea
   * (AND con statuses/deuda). Nodo o AP SOLOS ya son segmento válido — el caso
   * "aviso de corte a TODOS los del nodo X".
   */
  networkSiteId?: string | null;
  /**
   * node-segment — filtro por AP (`AccessPoint.id`), con o sin nodo. Si vienen
   * AMBOS, deben matchear en EL MISMO contrato. Ausente/null/'' = sin filtro.
   */
  accessPointId?: string | null;
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
  /**
   * messaging-bulk-inbox (F1) — texto plano del template (TemplateDto.body)
   * capturado en CreateCampaign, para renderizar el body real al proyectar al
   * inbox. `null` en campañas viejas (pre-feature) o templates sin body de texto.
   */
  templateBody: string | null;
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
  /**
   * bulk-csv-recipients (PER-1) — `null` para un contacto CSV crudo que NO
   * vinculó a ningún `Client` (CSV-3). Migración aditiva sobre una columna que
   * antes era NOT NULL; `@@unique([campaignId, clientId])` se conserva (Postgres
   * trata cada NULL como distinto en un unique).
   */
  clientId: string | null;
  /**
   * bulk-csv-recipients (PER-1/D1) — snapshot del nombre tipeado en el CSV,
   * SOLO presente en filas `clientId: null` (un vinculado usa `Client.name`
   * fresco siempre, D4). Auditable igual que `phoneNormalized`/`phoneE164`.
   */
  contactName: string | null;
  /** Clave de de-dup (`normalizePhone` verbatim) — auditable. */
  phoneNormalized: string;
  /** Destino REAL enviado (`toWhatsAppE164`) — auditable. */
  phoneE164: string;
  status: CampaignRecipientStatus;
  /** SM… de Twilio cuando `status === 'sent'`. */
  providerId: string | null;
  /** Link al mirror F1 si el cliente responde (F3/opcional). */
  chatwootConversationId: number | null;
  /**
   * messaging-bulk-inbox (F1) — lazo al mirror local (Conversation.id) seteado
   * por la proyección al inbox. Es la VERDAD de la etiqueta #1 y del link de la
   * proyección. `null` hasta que la proyección corre (o si nunca se envió).
   */
  conversationId: string | null;
  /** Motivo del fallo por-fila, SANEADO (HIST-3 — nunca el payload crudo del proveedor). */
  error: string | null;
  sentAt: string | null;
  /** Recién se llena en F3 (status callback Twilio). */
  deliveredAt: string | null;
  createdAt: string;
}
