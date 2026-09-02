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
  /** ISO — `createdAt + 15min`. */
  expiresAt: string;
  /** ISO — seteado ATÓMICAMENTE al crear la Campaign (D8). `null` = no consumido. */
  consumedAt: string | null;
  /** Lazo 1:1 al resultado; SIN FK (el preview es efímero, D1.b). */
  campaignId: string | null;
  createdAt: string;
}
