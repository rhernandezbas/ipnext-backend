import type { CampaignRecipientCandidate, CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import { normalizePhone, PHONE_MIN_SIGNIFICANT_DIGITS } from '@application/use-cases/recapture/matchActiveClient';
import { toWhatsAppE164 } from './toWhatsAppE164';

/** bulk-csv-recipients (CSV-1) — un contacto normalizado (trim, sin ambos-vacíos) del CSV. */
export interface ManualContactInput {
  name: string;
  phone: string;
  /**
   * external-bulk-messaging (D4.e punto 1) — literales POR-RECIPIENT del caller
   * externo. Ausente/`undefined` en TODO dominio que no lo usa (manual UI/CSV
   * humano). Pass-through puro acá: `matchManualContacts` NO lo valida ni lo
   * transforma, solo lo carga en las resoluciones que SÍ se envían.
   */
  variables?: Record<string, string>;
}

/**
 * bulk-csv-recipients (D3, B2.2) — resolución de un contacto CSV: vinculado a un
 * `Client` existente (`linked`), crudo sin match (`raw`), o excluido por una
 * validación de FILA (defensa en profundidad — el FE ya filtra estos casos,
 * D9) ANTES de intentar el match.
 */
export type ManualContactResolution =
  | { kind: 'linked'; candidate: CampaignRecipientCandidate; contactName: string; variables?: Record<string, string> }
  | { kind: 'raw'; name: string; phone: string; phoneNormalized: string; phoneE164: string; variables?: Record<string, string> }
  | { kind: 'excluded'; name: string; phone: string; reason: 'sin_nombre' | 'sin_telefono' | 'telefono_invalido' | 'opt_out' };

/**
 * bulk-csv-recipients (D3, B2.2) — matchea cada `manualContacts` contra el
 * universo COMPLETO de `Client` (`segmentSource.listSegmentRecipients({statuses:
 * []})`, el escape hatch OPT-2 ya documentado en `PrismaCustomerRepository.ts:
 * 224-227`) por igualdad EXACTA de `normalizePhone` (NO `suffixMatch` — acá el
 * match decide OWNERSHIP del envío, un falso positivo manda la deuda de OTRO).
 *
 * Ambigüedad (2+ Clients con la misma clave normalizada): gana un cliente cuyo
 * `status !== 'baja'` sobre uno `baja` (el vínculo debe reflejar al titular
 * VIGENTE); desempate determinístico por `clientId` menor.
 *
 * Cero query nueva más allá de la YA pagada por `resolveCombinedRecipients`
 * cuando el segmento tiene criterio (misma resolución in-memory, tradeoff
 * recall-over-pagination ya aceptado, `ListSegmentRecipients.ts:15-24`). Solo se
 * paga cuando `contacts` no está vacío.
 */
export async function matchManualContacts(
  contacts: ManualContactInput[],
  segmentSource: CampaignSegmentSource,
): Promise<ManualContactResolution[]> {
  if (contacts.length === 0) return [];

  const universe = await segmentSource.listSegmentRecipients({ statuses: [] });
  const byPhone = buildClientPhoneIndex(universe);
  const optOutSuffixes = buildOptOutSuffixIndex(universe);

  return contacts.map((contact): ManualContactResolution => {
    const name = contact.name;
    const phone = contact.phone;

    // D9 — defensa en profundidad de FILA (el FE ya filtra sin_nombre/sin_telefono
    // sobre la estructura del CSV; acá es la AUTORIDAD).
    if (name === '') return { kind: 'excluded', name, phone, reason: 'sin_nombre' };
    if (phone === '') return { kind: 'excluded', name, phone, reason: 'sin_telefono' };

    const phoneE164 = toWhatsAppE164(phone);
    const phoneNormalized = normalizePhone(phone);
    if (phoneE164 === null || phoneNormalized === null) {
      return { kind: 'excluded', name, phone, reason: 'telefono_invalido' };
    }

    const matched = byPhone.get(phoneNormalized);
    if (matched) return { kind: 'linked', candidate: matched, contactName: name, variables: contact.variables };

    // M1 (review fix wave) — sin match EXACTO (D3), pero compliance es NO
    // NEGOCIABLE: un crudo cuyo SUFIJO coincide con un Client opted-out se
    // EXCLUYE igual, aunque NO se "vincula" (ownership sigue siendo exact-match,
    // D3 intacto). Cubre el drift de formato documentado en
    // matchActiveClient.ts:33-35 (el "15" móvil embebido que `normalizePhone`
    // no quita) — ver `buildOptOutSuffixIndex` para el porqué de N=6.
    if (optOutSuffixes.has(phoneNormalized.slice(-PHONE_MIN_SIGNIFICANT_DIGITS))) {
      return { kind: 'excluded', name, phone, reason: 'opt_out' };
    }

    return { kind: 'raw', name, phone, phoneNormalized, phoneE164, variables: contact.variables };
  });
}

/**
 * D3 — índice `normalizePhone(client.phone) → candidate`, resolviendo ambigüedad
 * (2+ clientes con la misma clave): gana el `status !== 'baja'`, desempate por
 * `clientId` menor. Recorrido único, criterio de "mínimo corriente" — el ganador
 * actual se compara contra cada candidato nuevo, transitivo y determinístico sin
 * importar el orden de llegada.
 */
function buildClientPhoneIndex(candidates: CampaignRecipientCandidate[]): Map<string, CampaignRecipientCandidate> {
  const map = new Map<string, CampaignRecipientCandidate>();
  for (const candidate of candidates) {
    const key = normalizePhone(candidate.phone);
    if (key === null) continue;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, candidate);
      continue;
    }

    const existingIsBaja = existing.status === 'baja';
    const candidateIsBaja = candidate.status === 'baja';
    if (existingIsBaja && !candidateIsBaja) {
      map.set(key, candidate); // el no-baja gana sobre el baja
    } else if (existingIsBaja === candidateIsBaja && candidate.clientId < existing.clientId) {
      map.set(key, candidate); // empate en baja-ness → desempate por clientId menor
    }
  }
  return map;
}

/**
 * M1 (review fix wave) — set de sufijos (últimos `PHONE_MIN_SIGNIFICANT_DIGITS`
 * dígitos) de los `Client` CON opt-out, para el check de compliance de un
 * contacto crudo que NO vinculó por match exacto (D3).
 *
 * ¿Por qué N=6 y NO el N=8 de `PHONE_SUFFIX_LENGTH` (`matchActiveClient`/
 * `GetClientContextByPhone`)? Es el ÚNICO largo que sobrevive al peor caso de
 * área AR de 4 dígitos (NSN=10 = área 4 + abonado 6): la ventana de 6 cae
 * SIEMPRE dentro del abonado y nunca roza el área, así que un "15" embebido
 * (que solo desplaza 2 posiciones el borde área/abonado, sin tocar el abonado
 * en sí) no la desalinea. Verificado con área "3364" (4 díg): el cliente
 * normaliza a `3364123456`, el mismo teléfono con "15" embebido normaliza a
 * `336415123456` (gap documentado en `matchActiveClient.ts:33-35) — con N=8 los
 * últimos 8 dígitos NO coinciden (`15123456` vs `64123456`, el "15" corrió la
 * ventana), con N=6 SÍ (`123456` en ambos, el abonado puro). N=8 es el criterio
 * correcto para D3/CTX-1 (match informativo/de OWNERSHIP, donde MENOS falsos
 * positivos importa más); acá el sesgo es al revés — un falso positivo
 * (sobre-excluir) es compliance-seguro, un falso negativo (dejar pasar un
 * opt-out) NO lo es, así que un N más chico y más permisivo es la elección
 * correcta para ESTE check puntual.
 */
function buildOptOutSuffixIndex(candidates: CampaignRecipientCandidate[]): Set<string> {
  const suffixes = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.whatsappOptOutAt == null) continue;
    const key = normalizePhone(candidate.phone);
    if (key === null) continue;
    suffixes.add(key.slice(-PHONE_MIN_SIGNIFICANT_DIGITS));
  }
  return suffixes;
}
