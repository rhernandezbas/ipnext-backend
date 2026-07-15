import type {
  CampaignSegmentSource,
  ManualRecipientSource,
} from '@domain/ports/CustomerRepository';
import {
  ManualRecipientsNotFoundError,
  TooManyManualRecipientsError,
} from '@domain/errors/messaging-bulk';
import { resolveRecipients, ResolvedRecipient } from './resolveRecipients';
import { segmentHasCriteria, SegmentCriteria } from './assertSegmentIsFiltered';

/**
 * manual-recipients (FIX-3) — cota superior de la lista manual NORMALIZADA. La
 * lista manual es HAND-CURATED (el operador elige clientes puntuales en el
 * composer): unos pocos miles ya es un techo GENEROSO. Un payload multi-miles
 * jamás es una curaduría legítima y explotaría la query batch `id IN (...)` hacia
 * el techo de ~65535 bind params de Postgres (500). El envío masivo de miles va
 * por el FILTRO del segmento, no por la lista manual. 5000 deja headroom de sobra
 * bajo el límite de Postgres incluso con otros params en la misma sentencia.
 */
export const MAX_MANUAL_RECIPIENTS = 5000;

/** FIX-2 — desglose de exclusiones (opt-out/dedup-teléfono/teléfono-inválido). */
export interface RecipientSkipCounts {
  optedOut: number;
  duplicatePhone: number;
  invalidPhone: number;
}

export interface CombinedRecipientsResult {
  /** Unión (segmento ∪ manual) deduplicada por `clientId` Y por teléfono, ordenada por `clientId`. */
  resolved: ResolvedRecipient[];
  /** Destinatarios resueltos SOLO del segmento (post opt-out/dedup/teléfono). */
  segmentResolved: ResolvedRecipient[];
  /** Destinatarios resueltos de la lista manual NO-overlap (post opt-out/dedup/teléfono). */
  manualResolved: ResolvedRecipient[];
  /** Exclusiones del SEGMENTO (SEG-2/SEG-3/SEG-4). */
  segmentSkipped: RecipientSkipCounts;
  /**
   * FIX-2 — exclusiones de la LISTA MANUAL (opt-out/teléfono-inválido/duplicate-phone
   * incl. el colapso cross-set del FIX-1), EXCLUYENDO los manuales que hacen overlap
   * por `clientId` con el segmento (ésos ya los contabiliza `segmentSkipped`/`resolved`
   * — no se doble-cuentan). El preview suma `segmentSkipped + manualSkipped`.
   */
  manualSkipped: RecipientSkipCounts;
  /** Conteo por `status` sobre la UNIÓN (receptores reales). */
  statusCounts: Record<string, number>;
}

/**
 * manual-recipients (MAN-1..MAN-4) — helper COMPARTIDO por `CreateCampaign` y
 * `PreviewCampaignSegment`. Orquesta:
 *
 *  1. Resolver el segmento SOLO si tiene criterio real (`segmentHasCriteria`) —
 *     si no (caso "solo manual"), NO se toca la fuente (evita `where:{}`).
 *  2. Resolver la lista manual (si hay): batch `findRecipientCandidatesByIds` →
 *     detectar faltantes por set-diff → `ManualRecipientsNotFoundError` (MAN-3,
 *     fail-loud) → `resolveRecipients` (MAN-4: opt-out excluido SIEMPRE, teléfono
 *     inválido descartado, dedup por `normalizePhone`).
 *  3. Unión dedup por `clientId` (segmento primero, manual llena huecos), ordenada.
 *
 * La existencia es fail-loud (MAN-3); las exclusiones de compliance son
 * silenciosas (igual que el segmento). El dedup de la UNIÓN es por `clientId`
 * (protege el `@@unique[campaignId, clientId]`) Y por TELÉFONO normalizado
 * (FIX-1): un manual con `clientId` distinto pero MISMO teléfono que un recipient
 * del segmento se EXCLUYE (evita 2 WhatsApp al mismo número). El segmento tiene
 * precedencia; el manual colisionante se cuenta en `manualSkipped.duplicatePhone`.
 * El overlap por `clientId` con el segmento NO se doble-cuenta (ver FIX-2 y design
 * §Decisión-6/§Decisión-9).
 */
export async function resolveCombinedRecipients(params: {
  segment: SegmentCriteria;
  manualClientIds: string[];
  segmentSource: CampaignSegmentSource;
  manualRecipientSource?: ManualRecipientSource;
}): Promise<CombinedRecipientsResult> {
  const { segment, manualClientIds, segmentSource, manualRecipientSource } = params;

  // FIX-3 — cota superior ANTES de tocar la DB (segmento o manual): un payload
  // multi-miles reventaría el límite de bind params de Postgres → 500. Rechazo
  // tipado → 422. `manualClientIds` ya llega normalizado (dedup + sin vacíos), así
  // que la cota mide los ids REALES que pegarían al `id IN (...)`.
  if (manualClientIds.length > MAX_MANUAL_RECIPIENTS) {
    throw new TooManyManualRecipientsError(manualClientIds.length, MAX_MANUAL_RECIPIENTS);
  }

  // 1. Segmento — solo si tiene criterio real. Guardamos los clientIds de TODOS los
  // candidatos (no solo los resueltos) para detectar el overlap con la lista manual
  // sin doble-contar (FIX-2): un manual que YA es candidato del segmento ya está
  // contabilizado ahí (como resuelto o como excluido).
  let segmentResolved: ResolvedRecipient[] = [];
  let segmentSkipped: RecipientSkipCounts = { optedOut: 0, duplicatePhone: 0, invalidPhone: 0 };
  const segmentCandidateIds = new Set<string>();
  if (segmentHasCriteria(segment)) {
    const candidates = await segmentSource.listSegmentRecipients({
      statuses: segment.statuses,
      balanceMin: segment.balanceMin,
      balanceMax: segment.balanceMax,
    });
    for (const c of candidates) segmentCandidateIds.add(c.clientId);
    const r = resolveRecipients(candidates);
    segmentResolved = r.resolved;
    segmentSkipped = { optedOut: r.excludedOptOut, duplicatePhone: r.dedupCollapsed, invalidPhone: r.excludedNoPhone };
  }

  // 2. Lista manual — fail-loud en ids inexistentes. Se filtra el overlap por
  // clientId con el segmento ANTES de resolver: esos ya los cuenta el segmento
  // (FIX-2, no doble-contar). El resto pasa por el MISMO `resolveRecipients`
  // (opt-out/teléfono/dedup-por-teléfono-dentro-del-set).
  let manualResolved: ResolvedRecipient[] = [];
  let manualSkipped: RecipientSkipCounts = { optedOut: 0, duplicatePhone: 0, invalidPhone: 0 };
  if (manualClientIds.length > 0) {
    if (!manualRecipientSource) {
      // Defensivo — nunca ocurre en el wiring real (app.ts inyecta customerAdapter).
      throw new Error('resolveCombinedRecipients: manualRecipientSource requerido para manualClientIds');
    }
    const candidates = await manualRecipientSource.findRecipientCandidatesByIds(manualClientIds);
    const foundIds = new Set(candidates.map((c) => c.clientId));
    const missing = manualClientIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ManualRecipientsNotFoundError(missing);
    }
    const manualNonOverlap = candidates.filter((c) => !segmentCandidateIds.has(c.clientId));
    const r = resolveRecipients(manualNonOverlap);
    manualResolved = r.resolved;
    manualSkipped = { optedOut: r.excludedOptOut, duplicatePhone: r.dedupCollapsed, invalidPhone: r.excludedNoPhone };
  }

  // 3. Unión dedup por clientId Y por teléfono normalizado (FIX-1). El segmento
  // entra primero con precedencia total (por clientId y por teléfono); el manual
  // llena huecos SOLO si su clientId y su teléfono no están ya en la unión. El
  // manual colapsado por teléfono cross-set se suma a `manualSkipped.duplicatePhone`.
  const byClientId = new Map<string, ResolvedRecipient>();
  const seenPhones = new Set<string>();
  for (const r of segmentResolved) {
    byClientId.set(r.clientId, r);
    seenPhones.add(r.phoneNormalized);
  }
  let crossSetDuplicatePhone = 0;
  for (const r of manualResolved) {
    if (byClientId.has(r.clientId)) continue; // defensivo (el overlap por clientId ya se filtró)
    if (seenPhones.has(r.phoneNormalized)) {
      crossSetDuplicatePhone++;
      continue;
    }
    byClientId.set(r.clientId, r);
    seenPhones.add(r.phoneNormalized);
  }
  manualSkipped = { ...manualSkipped, duplicatePhone: manualSkipped.duplicatePhone + crossSetDuplicatePhone };

  const resolved = Array.from(byClientId.values()).sort((a, b) => a.clientId.localeCompare(b.clientId));

  const statusCounts: Record<string, number> = {};
  for (const r of resolved) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  return { resolved, segmentResolved, manualResolved, segmentSkipped, manualSkipped, statusCounts };
}

/** Normaliza la lista manual del input: dedup + descarta no-strings/vacíos. */
export function normalizeManualClientIds(raw: string[] | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
