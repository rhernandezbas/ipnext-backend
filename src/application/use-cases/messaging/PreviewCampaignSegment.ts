import type { CampaignSegmentSource, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { PreviewSegmentInput, PreviewSegmentOutput } from '@application/dto/messaging-bulk.dto';
import { assertHasRecipients } from './assertHasRecipients';
import { resolveCombinedRecipients, normalizeManualClientIds, normalizeManualContacts } from './resolveCombinedRecipients';

/** Muestra acotada del preview (design §3.2) — no es el `count` real, solo una vidriera. */
const SAMPLE_SIZE = 20;

/**
 * messaging-bulk (F2, SEG-1..SEG-5) — a.k.a. `CountRecipients`. Resuelve el
 * segmento de solo-lectura: delega la resolución narrow en
 * `CampaignSegmentSource.listSegmentRecipients` (status IN + rango balanceDue,
 * SEG-1) y aplica `resolveRecipients` (SEG-2 opt-out / SEG-3 de-dup / SEG-4
 * teléfono inválido) en memoria.
 *
 * SEG-5 — de solo lectura por construcción: este use case NO recibe ningún
 * `CampaignRepository`, no puede persistir nada aunque quisiera.
 *
 * Gate RBAC `messaging.bulk` se aplica en la ruta (Batch 7), no acá.
 */
export class PreviewCampaignSegment {
  constructor(
    private readonly segmentSource: CampaignSegmentSource,
    // manual-recipients (MAN-5) — OPCIONAL: los tests/wiring segment-only quedan
    // intactos (1 arg). Requerido solo cuando el input trae `manualClientIds`.
    private readonly manualRecipientSource?: ManualRecipientSource,
  ) {}

  async execute(input: PreviewSegmentInput): Promise<PreviewSegmentOutput> {
    // manual-recipients (MAN-5) — lista manual normalizada (dedup + sin vacíos).
    const manualClientIds = normalizeManualClientIds(input.manualClientIds);
    // bulk-csv-recipients (CSV-6) — 4to dominio normalizado.
    const manualContacts = normalizeManualContacts(input.manualContacts);

    // MAN-2 (extiende FIX-8) — válido con segmento filtrado, O lista manual no
    // vacía, O manualContacts no vacío; rechaza ANTES de tocar la fuente si los
    // TRES están vacíos.
    assertHasRecipients(input, manualClientIds, manualContacts);

    // MAN-5 + bulk-csv-recipients (CSV-6) — cuenta la UNIÓN (segmento ∪ manuales ∪
    // CSV) deduplicada por clientId Y por teléfono (FIX-1/CSV-4). FIX-2/CSV-6:
    // `skipped` RECONCILIA las exclusiones de las 3 fuentes (opt-out/teléfono-
    // inválido/duplicate-phone), sin doble-contar el overlap. Invariante: count
    // (enviables) + Σ skipped = destinatarios únicos considerados.
    const { resolved, segmentSkipped, manualSkipped, csvSkipped, statusCounts } = await resolveCombinedRecipients({
      segment: input,
      manualClientIds,
      manualContacts,
      segmentSource: this.segmentSource,
      manualRecipientSource: this.manualRecipientSource,
    });

    return {
      count: resolved.length,
      sample: resolved.slice(0, SAMPLE_SIZE).map((r) => ({
        clientId: r.clientId,
        name: r.name,
        phoneE164: r.phoneE164,
        status: r.status,
      })),
      skipped: {
        optedOut: segmentSkipped.optedOut + manualSkipped.optedOut + csvSkipped.optedOut,
        duplicatePhone: segmentSkipped.duplicatePhone + manualSkipped.duplicatePhone + csvSkipped.duplicatePhone,
        invalidPhone: segmentSkipped.invalidPhone + manualSkipped.invalidPhone + csvSkipped.invalidPhone,
      },
      statusCounts,
    };
  }
}
