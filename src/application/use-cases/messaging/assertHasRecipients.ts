import { assertSegmentIsFiltered, SegmentCriteria } from './assertSegmentIsFiltered';

/**
 * manual-recipients (MAN-2) — guard para `CreateCampaign`/`PreviewCampaignSegment`
 * en modo COMBINABLE (segmento + lista manual). Una campaña es válida si hay:
 *  - una lista manual NO vacía (target válido por sí solo), O
 *  - un segmento con criterio real (`assertSegmentIsFiltered`).
 *
 * Se rechaza (con `UnfilteredSegmentError`) SOLO cuando AMBOS están vacíos —
 * evita el `where:{}` = toda la base (FIX-8). NO reemplaza a `assertSegmentIsFiltered`:
 * `ListSegmentRecipients` (que NO recibe lista manual) sigue usando ese guard directo.
 */
export function assertHasRecipients(segment: SegmentCriteria, manualClientIds: string[]): void {
  if (manualClientIds.length > 0) return;
  assertSegmentIsFiltered(segment);
}
