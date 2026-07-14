import type { CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import { normalizePhone } from '@application/use-cases/recapture/matchActiveClient';
import { toWhatsAppE164 } from './toWhatsAppE164';

/**
 * messaging-bulk (F2, design §3.3 paso 1, T3.5) — helper puro compartido por
 * `PreviewCampaignSegment` y `CreateCampaign` (evita duplicar la lógica de
 * exclusión/de-dup entre ambos).
 */
export interface ResolvedRecipient {
  clientId: string;
  name: string;
  /** Clave de de-dup (`normalizePhone` verbatim) — auditable. */
  phoneNormalized: string;
  /** Destino REAL para el envío (`toWhatsAppE164`). */
  phoneE164: string;
  balanceDue: number | null;
}

export interface ResolveRecipientsResult {
  resolved: ResolvedRecipient[];
  /** SEG-2 — excluidos por `whatsappOptOutAt != null`. */
  excludedOptOut: number;
  /** SEG-4 — `toWhatsAppE164` devolvió `null` (teléfono ausente/basura). */
  excludedNoPhone: number;
  /** SEG-3 — colapsados por de-dup de `normalizePhone` (no cuenta el sobreviviente). */
  dedupCollapsed: number;
}

/**
 * Resuelve el universo de destinatarios enviables de un segmento:
 * 1. SEG-2 — excluye SIEMPRE `whatsappOptOutAt != null` (no negociable).
 * 2. SEG-4 — descarta candidatos cuyo `toWhatsAppE164(phone)` es `null`
 *    (teléfono ausente o basura, no enviable).
 * 3. SEG-3 — de-dup por `normalizePhone(phone)` VERBATIM: dos candidatos que
 *    normalizan igual cuentan como UN destinatario — gana el de `clientId`
 *    menor (determinístico).
 *
 * Pura, total — nunca muta `candidates`, nunca throws.
 */
export function resolveRecipients(candidates: CampaignRecipientCandidate[]): ResolveRecipientsResult {
  let excludedOptOut = 0;
  let excludedNoPhone = 0;
  let dedupCollapsed = 0;

  const byNormalized = new Map<string, ResolvedRecipient>();

  for (const candidate of candidates) {
    if (candidate.whatsappOptOutAt != null) {
      excludedOptOut++;
      continue;
    }

    const phoneE164 = toWhatsAppE164(candidate.phone);
    const phoneNormalized = normalizePhone(candidate.phone);
    if (phoneE164 === null || phoneNormalized === null) {
      excludedNoPhone++;
      continue;
    }

    const entry: ResolvedRecipient = {
      clientId: candidate.clientId,
      name: candidate.name,
      phoneNormalized,
      phoneE164,
      balanceDue: candidate.balanceDue,
    };

    const existing = byNormalized.get(phoneNormalized);
    if (!existing) {
      byNormalized.set(phoneNormalized, entry);
    } else {
      dedupCollapsed++;
      if (entry.clientId < existing.clientId) {
        byNormalized.set(phoneNormalized, entry);
      }
    }
  }

  const resolved = Array.from(byNormalized.values()).sort((a, b) => a.clientId.localeCompare(b.clientId));

  return { resolved, excludedOptOut, excludedNoPhone, dedupCollapsed };
}
