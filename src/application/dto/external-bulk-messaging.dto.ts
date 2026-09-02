/**
 * external-bulk-messaging (task 2.1) — DTOs curados para el flujo M2M de 2 pasos
 * (`validate` → `send`) del envío masivo de WhatsApp vía la API Externa.
 *
 * Nota de nombres (D12/VAL-9 vs VAL-2 prose): spec.md's VAL-2 body/scenarios
 * usan `reason:'duplicate'`/`'opted_out'` (inglés) mientras que D12 (el wire
 * contract citado explícitamente por VAL-9, "forma exacta D12") y tasks.md 2.1
 * usan `'duplicado'`/`'opt_out'`. Es un drift interno del propio spec.md (no
 * introducido acá). Estos DTOs siguen D12 — es el wire contract, la fuente que
 * `sdd-verify` compara contra la respuesta HTTP real.
 */
import type { CampaignStatus } from '@domain/entities/campaign';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

/** Un destinatario del wire — VAL-1. */
export interface ValidateExternalBulkRecipientInput {
  phone: string;
  /** Ausente ⇒ `name = phone` (crudo, D4.b) — se resuelve dentro del use case. */
  name?: string;
  /** Pisa a `variables` GLOBAL por KEY tras el merge (VAL-10). */
  variables?: Record<string, string>;
}

/**
 * VAL-1 — `templateRef` (contentSid) o `templateName` (friendlyName, D4.d):
 * al menos uno de los dos MUST estar presente.
 */
export interface ValidateExternalBulkInput {
  templateRef?: string;
  templateName?: string;
  /** Literales GLOBALES — default para todos los recipients (D4.c). */
  variables?: Record<string, string>;
  chatwootLabel?: string;
  recipients: ValidateExternalBulkRecipientInput[];
}

/** D12 — union EXACTA del wire contract (ver nota de nombres arriba). */
export type ExternalBulkInvalidReason =
  | 'sin_telefono'
  | 'telefono_invalido'
  | 'opt_out'
  | 'duplicado'
  | 'non_mobile'
  | 'variables_faltantes';

export interface ValidateExternalBulkValidRecipientDto {
  phone: string;
  name: string;
  /** El mapa MERGEADO efectivo de ESTE destinatario (VAL-9) — no el global crudo. */
  variables: Record<string, string>;
  renderedMessage: string;
}

export interface ValidateExternalBulkInvalidRecipientDto {
  /** El input crudo tal cual lo mandó el caller (el teléfono sin normalizar). */
  input: string;
  reason: ExternalBulkInvalidReason;
  /** SOLO presente cuando `reason === 'variables_faltantes'` — keys ORDENADAS. */
  missingVariables?: string[];
}

export interface ValidateExternalBulkCountsDto {
  received: number;
  valid: number;
  invalid: number;
  optedOut: number;
  duplicated: number;
}

export interface ValidateExternalBulkCapsDto {
  maxPerRequest: number;
  maxPerDay: number;
  remainingToday: number;
}

/** D12/VAL-9 — shape EXACTO de la respuesta 200 de `validate`. */
export interface ValidateExternalBulkOutput {
  previewId: string;
  /** ISO. */
  expiresAt: string;
  /** MUESTRA — el `renderedMessage` del PRIMER `valid` (`''` si no hay ninguno). */
  renderedMessage: string;
  counts: ValidateExternalBulkCountsDto;
  valid: ValidateExternalBulkValidRecipientDto[];
  invalid: ValidateExternalBulkInvalidRecipientDto[];
  caps: ValidateExternalBulkCapsDto;
}

/** Molde de referencia — no usado en el DTO en sí, documenta de dónde salen las keys declaradas (D4.c). */
export type ExternalBulkTemplateVariables = TemplateDto['variables'];

// ─── send (task 3.1, D12) ───────────────────────────────────────────────────

/**
 * `Idempotency-Key` viaja por HEADER, no por el body (molde `SendTemplateMessage`
 * — NUNCA en el DTO). El use case la recibe como argumento aparte de `execute()`.
 */
export interface SendExternalBulkInput {
  previewId: string;
}

/** D12 — shape EXACTO de la respuesta 202/200 de `send`. */
export interface SendExternalBulkOutput {
  campaignId: string;
  accepted: true;
  total: number;
  /**
   * Presente SOLO en el camino de replay (GUARD-0 hit, SEND-6/SEND-8 retry) —
   * ausente en un `send` fresco. `true` = se reanudo/ya estaba corriendo;
   * `false` (fix wave F1, F3) = la campana YA habia TERMINADO (`done`/`failed`)
   * y NO se re-arranco: la respuesta es puramente idempotente.
   */
  resumed?: boolean;
  /**
   * fix wave F1 (F3) — estado de la `Campaign` en el momento del replay
   * (`pending`|`running`|`done`|`failed`|`paused`). Solo en el camino de
   * replay: le dice al caller M2M si tiene que seguir poleando o si ya termino,
   * sin una segunda llamada a `GET /campaigns/:id`.
   */
  status?: CampaignStatus;
}
