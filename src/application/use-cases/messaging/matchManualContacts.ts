import type { CampaignRecipientCandidate, CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import { normalizePhone } from '@application/use-cases/recapture/matchActiveClient';
import { toWhatsAppE164 } from './toWhatsAppE164';

/** bulk-csv-recipients (CSV-1) — un contacto normalizado (trim, sin ambos-vacíos) del CSV. */
export interface ManualContactInput {
  name: string;
  phone: string;
}

/**
 * bulk-csv-recipients (D3, B2.2) — resolución de un contacto CSV: vinculado a un
 * `Client` existente (`linked`), crudo sin match (`raw`), o excluido por una
 * validación de FILA (defensa en profundidad — el FE ya filtra estos casos,
 * D9) ANTES de intentar el match.
 */
export type ManualContactResolution =
  | { kind: 'linked'; candidate: CampaignRecipientCandidate; contactName: string }
  | { kind: 'raw'; name: string; phone: string; phoneNormalized: string; phoneE164: string }
  | { kind: 'excluded'; name: string; phone: string; reason: 'sin_nombre' | 'sin_telefono' | 'telefono_invalido' };

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
    if (matched) return { kind: 'linked', candidate: matched, contactName: name };

    return { kind: 'raw', name, phone, phoneNormalized, phoneE164 };
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
