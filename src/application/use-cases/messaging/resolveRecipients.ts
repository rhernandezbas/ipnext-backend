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
  /**
   * messaging-bulk v1.1 (preview modal) — estado del cliente al momento de
   * resolver el segmento. `'unknown'` cuando el candidato no trae `status`
   * (paths que no lo completan, ej. el re-check per-envío de `SendCampaign`
   * vía `CampaignRecipientLookup` — nunca pasa por acá con `statusCounts`
   * real, pero `resolveRecipients` es compartido y debe seguir siendo total).
   */
  status: string;
}

/**
 * bulk-csv-recipients (D7, B2.1) — motivo de exclusión por-persona (spec.md
 * vocabulario COMPLETO del wire). `sin_nombre` solo lo produce un contacto CSV
 * (`resolveCombinedRecipients`) — un candidato con `Client` siempre trae `name`.
 * Tipo COMPARTIDO entre `resolveRecipients` (segmento/manual) y
 * `resolveCombinedRecipients` (CSV) para no duplicar el vocabulario.
 */
export type ExclusionReason = 'sin_nombre' | 'sin_telefono' | 'telefono_invalido' | 'opt_out' | 'duplicado';

/** bulk-csv-recipients (D7, B2.1) — un candidato excluido + el motivo (detalle por-persona). */
export interface ExcludedCandidate {
  candidate: CampaignRecipientCandidate;
  reason: ExclusionReason;
}

export interface ResolveRecipientsResult {
  resolved: ResolvedRecipient[];
  /** SEG-2 — excluidos por `whatsappOptOutAt != null`. */
  excludedOptOut: number;
  /** SEG-4 — `toWhatsAppE164` devolvió `null` (teléfono ausente/basura). */
  excludedNoPhone: number;
  /** SEG-3 — colapsados por de-dup de `normalizePhone` (no cuenta el sobreviviente). */
  dedupCollapsed: number;
  /**
   * messaging-bulk v1.1 (preview modal) — conteo de RECEPTORES (post opt-out/
   * dedup/teléfono-inválido, es decir sobre `resolved`) agrupados por `status`.
   */
  statusCounts: Record<string, number>;
  /**
   * bulk-csv-recipients (D7, B2.1) — ADITIVO: el detalle por-persona de CADA
   * exclusión, con el motivo DIFERENCIADO (`sin_telefono` = phone vacío/ausente
   * vs `telefono_invalido` = tenía dígitos pero `toWhatsAppE164` → `null`; antes
   * ambos colapsaban en `excludedNoPhone`). Los contadores de arriba se DERIVAN
   * de este detalle (backcompat exacto): `excludedNoPhone = |sin_telefono| +
   * |telefono_invalido|`, `excludedOptOut = |opt_out|`, `dedupCollapsed = |duplicado|`.
   */
  excluded: ExcludedCandidate[];
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
  const excluded: ExcludedCandidate[] = [];

  const byNormalized = new Map<string, ResolvedRecipient>();
  // bulk-csv-recipients (D7) — candidato ORIGINAL detrás del `ResolvedRecipient`
  // sobreviviente actual, para poder reportar `duplicado` sobre el candidato
  // EXACTO que pierde (incluido cuando el sobreviviente cambia por `clientId` menor).
  const survivorCandidateByNormalized = new Map<string, CampaignRecipientCandidate>();

  for (const candidate of candidates) {
    if (candidate.whatsappOptOutAt != null) {
      excludedOptOut++;
      excluded.push({ candidate, reason: 'opt_out' });
      continue;
    }

    // bulk-csv-recipients (D7) — diferencia `sin_telefono` (ausente/vacío) de
    // `telefono_invalido` (había dígitos pero no reconstruye un E164 válido).
    // Ambos siguen sumando a `excludedNoPhone` (backcompat exacto).
    const rawPhone = candidate.phone?.trim() ?? '';
    if (rawPhone === '') {
      excludedNoPhone++;
      excluded.push({ candidate, reason: 'sin_telefono' });
      continue;
    }

    const phoneE164 = toWhatsAppE164(candidate.phone);
    const phoneNormalized = normalizePhone(candidate.phone);
    if (phoneE164 === null || phoneNormalized === null) {
      excludedNoPhone++;
      excluded.push({ candidate, reason: 'telefono_invalido' });
      continue;
    }

    const entry: ResolvedRecipient = {
      clientId: candidate.clientId,
      name: candidate.name,
      phoneNormalized,
      phoneE164,
      balanceDue: candidate.balanceDue,
      status: candidate.status ?? 'unknown',
    };

    const existing = byNormalized.get(phoneNormalized);
    if (!existing) {
      byNormalized.set(phoneNormalized, entry);
      survivorCandidateByNormalized.set(phoneNormalized, candidate);
    } else {
      dedupCollapsed++;
      if (entry.clientId < existing.clientId) {
        // el nuevo candidato tiene id menor y gana — el que sobrevivía hasta
        // ahora pasa a `duplicado`.
        excluded.push({ candidate: survivorCandidateByNormalized.get(phoneNormalized)!, reason: 'duplicado' });
        byNormalized.set(phoneNormalized, entry);
        survivorCandidateByNormalized.set(phoneNormalized, candidate);
      } else {
        excluded.push({ candidate, reason: 'duplicado' });
      }
    }
  }

  const resolved = Array.from(byNormalized.values()).sort((a, b) => a.clientId.localeCompare(b.clientId));

  const statusCounts: Record<string, number> = {};
  for (const r of resolved) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }

  return { resolved, excludedOptOut, excludedNoPhone, dedupCollapsed, statusCounts, excluded };
}
