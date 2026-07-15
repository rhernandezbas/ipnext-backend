import type { CampaignSegmentSource, ManualRecipientSource } from '@domain/ports/CustomerRepository';
import type { PreviewSegmentInput, PreviewSegmentOutput } from '@application/dto/messaging-bulk.dto';
import { assertHasRecipients } from './assertHasRecipients';
import { resolveCombinedRecipients, normalizeManualClientIds } from './resolveCombinedRecipients';

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

    // MAN-2 (extiende FIX-8) — válido con segmento filtrado O lista manual no
    // vacía; rechaza ANTES de tocar la fuente si ambos están vacíos.
    assertHasRecipients(input, manualClientIds);

    // MAN-5 — cuenta la UNIÓN (segmento ∪ manuales) deduplicada por clientId Y por
    // teléfono (FIX-1). FIX-2: `skipped` RECONCILIA las exclusiones del segmento MÁS
    // las de la lista manual (opt-out/teléfono-inválido/duplicate-phone cross-set),
    // sin doble-contar el overlap (el helper ya excluye del `manualSkipped` los
    // manuales que hacen overlap por clientId con el segmento). Invariante:
    // count (enviables) + Σ skipped = destinatarios únicos considerados.
    const { resolved, segmentSkipped, manualSkipped, statusCounts } = await resolveCombinedRecipients({
      segment: input,
      manualClientIds,
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
        optedOut: segmentSkipped.optedOut + manualSkipped.optedOut,
        duplicatePhone: segmentSkipped.duplicatePhone + manualSkipped.duplicatePhone,
        invalidPhone: segmentSkipped.invalidPhone + manualSkipped.invalidPhone,
      },
      statusCounts,
    };
  }
}
