/**
 * external-bulk-messaging (D1) — `ExternalBulkPreview` domain entity. Molde
 * `Campaign`/`CampaignRecipient` (domain/entities/campaign.ts): plain domain
 * shape — the Prisma adapter maps to/from `prisma/schema.prisma`, the domain
 * NEVER imports Prisma (DIP estricto).
 *
 * Ephemeral preview of a 2-step external bulk send (validate → send). NOT a
 * `Campaign`: doesn't inflate the admin history nor the daily quota (D6, that
 * counts recipients actually `sent`).
 */

/**
 * `recipients` JSON shape — ALREADY normalized + deduped, WITH the per-recipient
 * variables already MERGED (global + recipient, D4.e/VAL-10). `name` is the raw
 * caller-provided name (or the phone itself when absent, D4.b) — cosmetic, does
 * NOT enter `externalBulkPayloadHash` (design.md D5).
 */
export interface ExternalBulkPreviewRecipient {
  phoneE164: string;
  phoneNormalized: string;
  name: string;
  variables: Record<string, string>;
}

/**
 * `invalid` JSON shape — one entry per excluded input, with its own reason.
 * `missingVariables` is populated ONLY for `reason:'variables_faltantes'`
 * (VAL-10) — a recipient excluded for missing a declared template variable
 * after the global+per-recipient merge.
 */
export interface ExternalBulkPreviewInvalidEntry {
  input: string;
  reason: string;
  missingVariables?: string[];
}

/**
 * twilio-credit-guard (D1.b/D4.b) — snapshot ADVISORY de lo que se le mostró
 * a quien autorizó el `validate` ("qué costaba, con qué saldo"). Shape
 * estructuralmente IDÉNTICA a `MessagingCreditDto`
 * (`application/use-cases/messaging/EstimateMessagingCost.ts`) — duplicada a
 * propósito, mismo criterio que `ExternalBulkPreviewRecipient` vs
 * `ValidateExternalBulkValidRecipientDto`: el dominio NUNCA importa un tipo
 * de `application/` (DIP estricto). FUERA del `payloadHash` (D1.c) — es dato
 * del proveedor/config, no input del caller.
 */
export type ExternalBulkPreviewCreditCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export interface ExternalBulkPreviewCreditSnapshot {
  available: string | null;
  currency: string;
  category: ExternalBulkPreviewCreditCategory;
  categoryAssumed?: true;
  /** fix wave F1 (F8) — `null` cuando la TARIFA no se pudo resolver; jamás un '0.0000' mentiroso. */
  unitCost: string | null;
  estimatedCost: string | null;
  sufficient: boolean;
  unknown?: true;
}

export interface ExternalBulkPreview {
  id: string;
  /** sha256 canónico del payload (D5) — anti-replay con payload distinto. */
  payloadHash: string;
  /** ContentSid resuelto (HX…) — el preview congela el REF, no el nombre (D4.d). */
  templateRef: string;
  /** friendlyName pedido por el caller — auditoría del input. */
  templateName: string;
  /** Literales `{"1":"...","2":"..."}` tal cual los mandó el caller (D4.c). */
  variables: Record<string, string>;
  chatwootLabel: string | null;
  recipients: ExternalBulkPreviewRecipient[];
  invalid: ExternalBulkPreviewInvalidEntry[];
  validCount: number;
  invalidCount: number;
  /**
   * twilio-credit-guard (D1.b) — snapshot advisory calculado en `validate`.
   * `null` para previews creados ANTES de este change (columna nullable, sin
   * backfill) — nunca fabricado retroactivamente.
   */
  credit: ExternalBulkPreviewCreditSnapshot | null;
  /** ISO — `createdAt + 15min`. */
  expiresAt: string;
  /** ISO — seteado ATÓMICAMENTE al crear la Campaign (D8). `null` = no consumido. */
  consumedAt: string | null;
  /** Lazo 1:1 al resultado; SIN FK (el preview es efímero, D1.b). */
  campaignId: string | null;
  createdAt: string;
}
