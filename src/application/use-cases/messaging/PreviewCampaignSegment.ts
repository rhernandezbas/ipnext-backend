import type { CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { PreviewSegmentInput, PreviewSegmentOutput } from '@application/dto/messaging-bulk.dto';
import { resolveRecipients } from './resolveRecipients';
import { assertSegmentIsFiltered } from './assertSegmentIsFiltered';

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
  constructor(private readonly segmentSource: CampaignSegmentSource) {}

  async execute(input: PreviewSegmentInput): Promise<PreviewSegmentOutput> {
    // FIX-8 — un segmento sin criterio apuntaría a TODA la base; se rechaza ANTES
    // de tocar la fuente (mismo guard que CreateCampaign — única fuente de verdad).
    assertSegmentIsFiltered(input);

    const candidates = await this.segmentSource.listSegmentRecipients({
      statuses: input.statuses,
      balanceMin: input.balanceMin,
      balanceMax: input.balanceMax,
    });

    const { resolved, excludedOptOut, excludedNoPhone, dedupCollapsed } = resolveRecipients(candidates);

    return {
      count: resolved.length,
      sample: resolved.slice(0, SAMPLE_SIZE).map((r) => ({
        clientId: r.clientId,
        name: r.name,
        phoneE164: r.phoneE164,
      })),
      skipped: {
        optedOut: excludedOptOut,
        duplicatePhone: dedupCollapsed,
        invalidPhone: excludedNoPhone,
      },
    };
  }
}
