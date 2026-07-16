import type {
  CampaignSegmentSource,
  ManualRecipientSource,
} from '@domain/ports/CustomerRepository';
import {
  ManualRecipientsNotFoundError,
  TooManyManualRecipientsError,
  TooManyManualContactsError,
} from '@domain/errors/messaging-bulk';
import { resolveRecipients, ResolvedRecipient, ExclusionReason, ExcludedCandidate } from './resolveRecipients';
import { segmentHasCriteria, SegmentCriteria } from './assertSegmentIsFiltered';
import { matchManualContacts, ManualContactInput } from './matchManualContacts';
import { toWhatsAppE164 } from './toWhatsAppE164';
import { normalizePhone } from '@application/use-cases/recapture/matchActiveClient';

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

/**
 * bulk-csv-recipients (CSV-5, FIX-3 molde) — cota INDEPENDIENTE de
 * `MAX_MANUAL_RECIPIENTS` para el 4to dominio (`manualContacts`). Un CSV de
 * miles de filas no es una curaduría legítima; protege el insert masivo y la
 * memoria del match por teléfono (`matchManualContacts`) — rechazo ANTES de
 * tocar la DB o el universo de `Client`.
 */
export const MAX_MANUAL_CONTACTS = 5000;

/** FIX-2 — desglose de exclusiones (opt-out/dedup-teléfono/teléfono-inválido). */
export interface RecipientSkipCounts {
  optedOut: number;
  duplicatePhone: number;
  invalidPhone: number;
}

/** bulk-csv-recipients (D7/D11) — de qué dominio vino un destinatario/exclusión resuelto. */
export type RecipientSource = 'segment' | 'manual' | 'csv';

/**
 * bulk-csv-recipients (D7/D11) — un destinatario de la UNIÓN de las 3 fuentes.
 * `clientId: null` únicamente para un contacto CSV crudo (CSV-3, sin `Client`
 * vinculado); en ese caso `name` es el nombre TIPEADO en el CSV.
 */
export interface CombinedResolvedRecipient {
  clientId: string | null;
  name: string;
  phoneNormalized: string;
  phoneE164: string;
  balanceDue: number | null;
  status: string;
  source: RecipientSource;
}

/**
 * bulk-csv-recipients (D7) — un excluido con motivo, de CUALQUIERA de las 3
 * fuentes. `clientId`/`status` solo presentes cuando el excluido SÍ resolvió a
 * un `Client` (opt-out o duplicado de un vinculado) — un `sin_nombre`/
 * `sin_telefono`/`telefono_invalido` de un contacto crudo nunca lo hace.
 */
export interface ExcludedDetailEntry {
  name: string;
  phone: string;
  reason: ExclusionReason;
  source: RecipientSource;
  clientId?: string;
  status?: string;
}

export interface CombinedRecipientsResult {
  /** Unión de las 3 fuentes, deduplicada por `clientId` (cuando aplica) Y por teléfono, ordenada. */
  resolved: CombinedResolvedRecipient[];
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
   * — no se doble-cuentan). El preview suma `segmentSkipped + manualSkipped + csvSkipped`.
   */
  manualSkipped: RecipientSkipCounts;
  /**
   * bulk-csv-recipients (CSV-6) — exclusiones del 4to dominio (`manualContacts`):
   * `sin_nombre`/`sin_telefono`/`telefono_invalido` → `invalidPhone`; `opt_out` de
   * un vinculado → `optedOut`; `duplicado` (dentro del CSV o cross-source) →
   * `duplicatePhone`. Mismos buckets del wire que segmento/manual (backcompat).
   */
  csvSkipped: RecipientSkipCounts;
  /** Conteo por `status` sobre la UNIÓN (receptores reales) — `no_cliente` para los crudos. */
  statusCounts: Record<string, number>;
  /**
   * bulk-csv-recipients (D7) — detalle por-persona de TODAS las exclusiones,
   * de las 3 fuentes (segmento + manual + CSV), en el orden en que se resolvieron.
   */
  excludedDetail: ExcludedDetailEntry[];
}

/**
 * manual-recipients (MAN-1..MAN-4) + bulk-csv-recipients (CSV-1..CSV-6) — helper
 * COMPARTIDO por `CreateCampaign`, `PreviewCampaignSegment` y
 * `ListSegmentRecipients`. Orquesta:
 *
 *  1. Resolver el segmento SOLO si tiene criterio real (`segmentHasCriteria`) —
 *     si no, NO se toca la fuente (evita `where:{}`).
 *  2. Resolver la lista manual (si hay): batch `findRecipientCandidatesByIds` →
 *     detectar faltantes por set-diff → `ManualRecipientsNotFoundError` (MAN-3,
 *     fail-loud) → `resolveRecipients` (MAN-4: opt-out excluido SIEMPRE, teléfono
 *     inválido descartado, dedup por `normalizePhone`).
 *  3. Resolver `manualContacts` (si hay, D3): `matchManualContacts` vincula cada
 *     contacto por teléfono contra el universo de `Client`; un vinculado con
 *     opt-out se excluye (`opt_out`), un vinculado `baja` se ADMITE con
 *     `status:'baja'` (flag no-excluyente), un crudo entra con `clientId: null`.
 *  4. Unión dedup por `clientId` (cuando aplica) Y por TELÉFONO normalizado
 *     (FIX-1, extendido a CSV en CSV-4), con precedencia segmento > manual > csv;
 *     dentro del CSV, la PRIMERA aparición de una clave gana.
 *
 * La existencia de `manualClientIds` es fail-loud (MAN-3); las exclusiones de
 * compliance son silenciosas (igual que el segmento) pero quedan RETENIDAS en
 * `excludedDetail` (D7) para el preview con detalle por-persona.
 */
export async function resolveCombinedRecipients(params: {
  segment: SegmentCriteria;
  manualClientIds: string[];
  /** bulk-csv-recipients (CSV-1) — YA normalizado (`normalizeManualContacts`). */
  manualContacts: ManualContactInput[];
  segmentSource: CampaignSegmentSource;
  manualRecipientSource?: ManualRecipientSource;
}): Promise<CombinedRecipientsResult> {
  const { segment, manualClientIds, manualContacts, segmentSource, manualRecipientSource } = params;

  // FIX-3 — cota superior ANTES de tocar la DB (segmento o manual): un payload
  // multi-miles reventaría el límite de bind params de Postgres → 500. Rechazo
  // tipado → 422. `manualClientIds` ya llega normalizado (dedup + sin vacíos), así
  // que la cota mide los ids REALES que pegarían al `id IN (...)`.
  if (manualClientIds.length > MAX_MANUAL_RECIPIENTS) {
    throw new TooManyManualRecipientsError(manualClientIds.length, MAX_MANUAL_RECIPIENTS);
  }
  // CSV-5 — cota INDEPENDIENTE para `manualContacts` (ya normalizado por el caller).
  if (manualContacts.length > MAX_MANUAL_CONTACTS) {
    throw new TooManyManualContactsError(manualContacts.length, MAX_MANUAL_CONTACTS);
  }

  // 1. Segmento — solo si tiene criterio real. Guardamos los clientIds de TODOS los
  // candidatos (no solo los resueltos) para detectar el overlap con la lista manual
  // sin doble-contar (FIX-2): un manual que YA es candidato del segmento ya está
  // contabilizado ahí (como resuelto o como excluido).
  let segmentResolved: ResolvedRecipient[] = [];
  let segmentSkipped: RecipientSkipCounts = { optedOut: 0, duplicatePhone: 0, invalidPhone: 0 };
  let segmentExcludedDetail: ExcludedDetailEntry[] = [];
  const segmentCandidateIds = new Set<string>();
  if (segmentHasCriteria(segment)) {
    const candidates = await segmentSource.listSegmentRecipients({
      statuses: segment.statuses,
      balanceMin: segment.balanceMin,
      balanceMax: segment.balanceMax,
      // node-segment — el filtro nodo/AP viaja al source (Prisma lo resuelve con
      // `contracts: { some: {...} }`); AND con statuses/deuda, mismo criterio.
      networkSiteId: segment.networkSiteId,
      accessPointId: segment.accessPointId,
    });
    for (const c of candidates) segmentCandidateIds.add(c.clientId);
    const r = resolveRecipients(candidates);
    segmentResolved = r.resolved;
    segmentSkipped = { optedOut: r.excludedOptOut, duplicatePhone: r.dedupCollapsed, invalidPhone: r.excludedNoPhone };
    segmentExcludedDetail = r.excluded.map((e) => toExcludedDetail(e, 'segment'));
  }

  // 2. Lista manual — fail-loud en ids inexistentes. Se filtra el overlap por
  // clientId con el segmento ANTES de resolver: esos ya los cuenta el segmento
  // (FIX-2, no doble-contar). El resto pasa por el MISMO `resolveRecipients`
  // (opt-out/teléfono/dedup-por-teléfono-dentro-del-set).
  let manualResolved: ResolvedRecipient[] = [];
  let manualSkipped: RecipientSkipCounts = { optedOut: 0, duplicatePhone: 0, invalidPhone: 0 };
  let manualExcludedDetail: ExcludedDetailEntry[] = [];
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
    manualExcludedDetail = r.excluded.map((e) => toExcludedDetail(e, 'manual'));
  }

  // 3. bulk-csv-recipients (D3, CSV-1..CSV-4) — contactos crudos del CSV.
  // `matchManualContacts` vincula por teléfono (o no); acá se aplica compliance
  // (opt-out del vinculado) y se arman los candidatos PRE-dedup para la unión.
  const csvSkipped: RecipientSkipCounts = { optedOut: 0, duplicatePhone: 0, invalidPhone: 0 };
  const csvExcludedDetail: ExcludedDetailEntry[] = [];
  const csvPreDedup: CombinedResolvedRecipient[] = [];
  if (manualContacts.length > 0) {
    const resolutions = await matchManualContacts(manualContacts, segmentSource);
    for (const res of resolutions) {
      if (res.kind === 'excluded') {
        // M1 (review fix wave) — `matchManualContacts` ahora también puede
        // devolver `reason: 'opt_out'` (crudo excluido por SUFIJO contra un
        // Client opted-out, sin vincularse — D3 exact-match intacto). Ese
        // motivo cuenta en `optedOut`, NO en `invalidPhone` (los otros 3
        // reasons de fila — sin_nombre/sin_telefono/telefono_invalido — sí).
        if (res.reason === 'opt_out') {
          csvSkipped.optedOut++;
        } else {
          csvSkipped.invalidPhone++;
        }
        csvExcludedDetail.push({ name: res.name, phone: res.phone, reason: res.reason, source: 'csv' });
        continue;
      }
      if (res.kind === 'linked') {
        const { candidate } = res;
        if (candidate.whatsappOptOutAt != null) {
          csvSkipped.optedOut++;
          csvExcludedDetail.push({
            name: candidate.name,
            phone: candidate.phone ?? '',
            reason: 'opt_out',
            source: 'csv',
            clientId: candidate.clientId,
            status: candidate.status,
          });
          continue;
        }
        const phoneE164 = toWhatsAppE164(candidate.phone);
        const phoneNormalized = normalizePhone(candidate.phone);
        if (phoneE164 === null || phoneNormalized === null) {
          // Defensivo: el `Client` matcheó por `normalizePhone` (D3) pero su
          // teléfono no reconstruye un E164 enviable (reglas de validez distintas
          // entre `normalizePhone` y `toWhatsAppE164`) — rarísimo, nunca 0.
          csvSkipped.invalidPhone++;
          csvExcludedDetail.push({
            name: candidate.name,
            phone: candidate.phone ?? '',
            reason: 'telefono_invalido',
            source: 'csv',
            clientId: candidate.clientId,
            status: candidate.status,
          });
          continue;
        }
        csvPreDedup.push({
          clientId: candidate.clientId,
          name: candidate.name,
          phoneNormalized,
          phoneE164,
          balanceDue: candidate.balanceDue,
          status: candidate.status ?? 'unknown',
          source: 'csv',
        });
        continue;
      }
      // raw — crudo, sin Client.
      csvPreDedup.push({
        clientId: null,
        name: res.name,
        phoneNormalized: res.phoneNormalized,
        phoneE164: res.phoneE164,
        balanceDue: null,
        status: 'no_cliente',
        source: 'csv',
      });
    }
  }

  // 4. Unión — segmento primero (precedencia total), después manual (overlap por
  // clientId ya filtrado arriba; overlap por teléfono cross-set se excluye acá),
  // después CSV (dedup por clientId Y por teléfono contra TODO lo ya admitido;
  // dentro del CSV, la PRIMERA aparición de una clave gana — CSV-4).
  const byClientId = new Map<string, CombinedResolvedRecipient>();
  const seenPhones = new Set<string>();
  const resolved: CombinedResolvedRecipient[] = [];

  function admit(item: CombinedResolvedRecipient): void {
    resolved.push(item);
    if (item.clientId !== null) byClientId.set(item.clientId, item);
    seenPhones.add(item.phoneNormalized);
  }

  for (const r of segmentResolved) admit({ ...r, source: 'segment' });

  for (const r of manualResolved) {
    if (byClientId.has(r.clientId)) continue; // defensivo (el overlap por clientId ya se filtró)
    if (seenPhones.has(r.phoneNormalized)) {
      manualSkipped.duplicatePhone++;
      manualExcludedDetail.push({ name: r.name, phone: r.phoneE164, reason: 'duplicado', source: 'manual', clientId: r.clientId, status: r.status });
      continue;
    }
    admit({ ...r, source: 'manual' });
  }

  for (const c of csvPreDedup) {
    const dup = seenPhones.has(c.phoneNormalized) || (c.clientId !== null && byClientId.has(c.clientId));
    if (dup) {
      csvSkipped.duplicatePhone++;
      csvExcludedDetail.push({
        name: c.name,
        phone: c.phoneE164,
        reason: 'duplicado',
        source: 'csv',
        ...(c.clientId !== null ? { clientId: c.clientId, status: c.status } : {}),
      });
      continue;
    }
    admit(c);
  }

  const statusCounts: Record<string, number> = {};
  for (const r of resolved) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  const excludedDetail = sortExcluded([...segmentExcludedDetail, ...manualExcludedDetail, ...csvExcludedDetail]);

  return {
    resolved: sortResolved(resolved),
    segmentResolved,
    manualResolved,
    segmentSkipped,
    manualSkipped,
    csvSkipped,
    statusCounts,
    excludedDetail,
  };
}

/**
 * bulk-csv-recipients (D7) — orden determinístico: por `clientId` ascendente
 * cuando ambos lo tienen (molde histórico, `localeCompare`); un crudo
 * (`clientId: null`) queda DESPUÉS de cualquier vinculado, y entre crudos se
 * preserva el orden de construcción (`Array.sort` es estable en Node ≥11 — el
 * orden del archivo CSV es intencional, D8).
 */
function sortResolved(items: CombinedResolvedRecipient[]): CombinedResolvedRecipient[] {
  return [...items].sort((a, b) => {
    if (a.clientId !== null && b.clientId !== null) return a.clientId.localeCompare(b.clientId);
    if (a.clientId === null && b.clientId === null) return 0;
    return a.clientId === null ? 1 : -1;
  });
}

/**
 * bulk-csv-recipients (LOW L4, review fix wave) — orden determinístico de
 * `excludedDetail`, molde `sortResolved`: `clientId` ascendente cuando está
 * presente en AMBOS lados (un excluido SIN clientId — sin_nombre/sin_telefono/
 * telefono_invalido/un crudo opt_out-por-sufijo, M1 — queda DESPUÉS); desempate
 * por `phone`, `name`, `reason` (íntegramente determinístico ante cualquier
 * empate, incluida la fila `sin_telefono` con `phone: ''` repetida).
 *
 * Sin este sort, `excludedDetail` hereda el orden de
 * `listSegmentRecipients()` — SIN `orderBy` (`PrismaCustomerRepository.ts:
 * 429-438`), Postgres NO garantiza el mismo orden entre dos `findMany` sin
 * `ORDER BY`. Como `view:'excluded'` (`ListSegmentRecipients`) re-resuelve la
 * unión completa en CADA página (no hay tabla persistida que paginar del lado
 * de la DB — D11), dos requests de páginas distintas podían, en teoría,
 * recibir el universo en orden distinto → duplicados/saltos al paginar. Barato:
 * un solo `Array.sort` sobre un array ya en memoria (mismo criterio que
 * `sortResolved`, sin query extra).
 */
function sortExcluded(items: ExcludedDetailEntry[]): ExcludedDetailEntry[] {
  return [...items].sort((a, b) => {
    if (a.clientId !== undefined && b.clientId !== undefined) {
      const byClientId = a.clientId.localeCompare(b.clientId);
      if (byClientId !== 0) return byClientId;
    } else if (a.clientId !== undefined || b.clientId !== undefined) {
      return a.clientId !== undefined ? -1 : 1;
    }
    const byPhone = a.phone.localeCompare(b.phone);
    if (byPhone !== 0) return byPhone;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.reason.localeCompare(b.reason);
  });
}

function toExcludedDetail(entry: ExcludedCandidate, source: RecipientSource): ExcludedDetailEntry {
  return {
    name: entry.candidate.name,
    phone: entry.candidate.phone ?? '',
    reason: entry.reason,
    source,
    clientId: entry.candidate.clientId,
    status: entry.candidate.status,
  };
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

/**
 * bulk-csv-recipients (B1.2) — normaliza `manualContacts`: trim de `name`/`phone`,
 * descarta filas con AMBOS vacíos post-trim (ruido de parseo, no una persona —
 * D10, ni cuenta para el cap ni para el detalle), PRESERVA el orden (D8: la
 * primera aparición de un teléfono duplicado gana). A diferencia de
 * `normalizeManualClientIds`, NO dedupea acá — el dedup por teléfono lo hace
 * `resolveCombinedRecipients` (CSV-4, con el motivo `duplicado` visible).
 */
export function normalizeManualContacts(raw: ManualContactInput[] | undefined): ManualContactInput[] {
  if (!raw) return [];
  const out: ManualContactInput[] = [];
  for (const c of raw) {
    const name = c.name.trim();
    const phone = c.phone.trim();
    if (name === '' && phone === '') continue;
    out.push({ name, phone });
  }
  return out;
}
